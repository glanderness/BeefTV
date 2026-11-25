package task

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/playback"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const (
	imageHeaderDecodeLimit = 2 << 20
	videoHeaderSniffLimit  = 4 << 10
)

type DeliveryMediaDeps struct {
	Repo              *repository.Repository
	DataDir           string
	AllowHTTPForTest  bool
	Resources         *localasset.Service
	DecodeDataURL     func(string) (string, []byte, error)
	BeginDownload     func(userID, identity string, timeout time.Duration) (context.Context, func(error), error)
	MaxBytes          func() (int64, error)
	Progress          *DeliveryProgressRegistry
	DecryptTaskInput  func(string) (string, error)
	DecryptSetting    func(string) (string, error)
	ResolveConfig     func(generation.Config) (generation.Config, error)
	ProtocolRegistry  *protocol.Registry
	RefreshManagedURL func(ctx context.Context, userID, identity, kind string, cause error) (string, bool, error)
	BindRuntime       func(context.Context, generation.CallMeta) context.Context
}

func PersistRemoteGenerationArtifact(deps DeliveryMediaDeps, userID, mediaType, artifactURL, identity string, downloadTimeout time.Duration) (*model.Resource, error) {
	if deps.Resources == nil {
		return nil, errors.New("generation media adapter is not initialized")
	}
	userID = strings.TrimSpace(userID)
	artifactURL = strings.TrimSpace(artifactURL)
	identity = strings.TrimSpace(identity)
	if userID == "" || artifactURL == "" || identity == "" {
		return nil, fmt.Errorf("generation artifact identity is incomplete")
	}
	var cleanups []func()
	defer func() {
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
	}()
	return deps.Resources.RecoverOwned(userID, identity, func() (localasset.RecoveredArtifact, error) {
		if strings.TrimSpace(mediaType) == "video" && (strings.HasPrefix(artifactURL, "http://") || strings.HasPrefix(artifactURL, "https://")) {
			artifact, cleanup, err := decodeRemoteVideoArtifactToFile(deps, userID, identity, mediaType, artifactURL, downloadTimeout)
			if cleanup != nil {
				cleanups = append(cleanups, cleanup)
			}
			return artifact, err
		}
		kind, data, mimeType, fileName, width, height, durationMs, err := DecodeGenerationArtifact(deps, userID, identity, mediaType, artifactURL, downloadTimeout)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		return localasset.RecoveredArtifact{
			Kind: kind, FileName: fileName, MimeType: mimeType,
			Size: int64(len(data)), Width: width, Height: height, DurationMs: durationMs,
			Body: bytes.NewReader(data),
		}, nil
	})
}

// PersistGeneratedVideoFile streams an already-finalized local video file into
// workspace resources via RecoverOwned without loading the video into RAM.
func PersistGeneratedVideoFile(resources *localasset.Service, userID, identity, mimeType, filePath string, width, height int, durationMs int64) (generation.ResourceInfo, error) {
	if resources == nil {
		return generation.ResourceInfo{}, errors.New("generation media adapter is not initialized")
	}
	file, err := os.Open(filePath)
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	ext := localasset.ExtensionFromMimeType(mimeType)
	resource, err := resources.RecoverOwned(userID, identity, func() (localasset.RecoveredArtifact, error) {
		if _, seekErr := file.Seek(0, io.SeekStart); seekErr != nil {
			return localasset.RecoveredArtifact{}, seekErr
		}
		return localasset.RecoveredArtifact{
			Kind:       "video",
			FileName:   "generated." + ext,
			MimeType:   mimeType,
			Size:       info.Size(),
			Width:      width,
			Height:     height,
			DurationMs: durationMs,
			Body:       file,
		}, nil
	})
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	return generation.ResourceInfoFromModel(userID, resource), nil
}

func resolveArtifactFileMeta(kind, mimeType, fileName string, head []byte) (string, string, string) {
	if kind == "video" {
		if normalized := generation.NormalizedMediaMIMEType("", head); strings.HasPrefix(normalized, "video/") {
			mimeType = normalized
		} else if normalized := generation.NormalizedMediaMIMEType(mimeType, head); strings.HasPrefix(normalized, "video/") {
			mimeType = normalized
		}
	}
	kind = localasset.NormalizeKind(kind, mimeType)
	ext := localasset.ExtensionFromMimeType(mimeType)
	if fileName == "" {
		fileName = "resource." + ext
	} else if ext != "bin" {
		curExt := strings.ToLower(filepath.Ext(fileName))
		if curExt == ".bin" || (kind == "video" && curExt != "" && curExt != "."+ext) {
			fileName = strings.TrimSuffix(fileName, filepath.Ext(fileName)) + "." + ext
		}
	}
	return kind, mimeType, fileName
}

func downloadManagedResumableFile(
	ctx context.Context,
	deps DeliveryMediaDeps,
	userID, identity, kind, artifactURL string,
	managed bool,
) (outbound.ResumableFileResult, error) {
	if managed && !deps.AllowHTTPForTest {
		ctx = outbound.WithPublicHTTPS(ctx)
	}
	if _, urlErr := outbound.ValidateOutboundURLContext(ctx, artifactURL); urlErr != nil {
		return outbound.ResumableFileResult{}, urlErr
	}
	limit, policyErr := deps.MaxBytes()
	if policyErr != nil {
		return outbound.ResumableFileResult{}, policyErr
	}
	headers, headerErr := ImageDownloadHeaders(deps.Repo, deps.DecryptTaskInput, deps.DecryptSetting, deps.ResolveConfig, deps.ProtocolRegistry, userID, identity, kind, artifactURL)
	if headerErr != nil {
		return outbound.ResumableFileResult{}, headerErr
	}
	downloadOptions := outbound.ResumableOptions{
		PartialPath: ArtifactDownloadPartialPath(deps.DataDir, userID, identity),
		Headers:     headers,
		MaxBytes:    outbound.ExclusiveByteLimit(limit),
		OnProgress: func(update outbound.ResumableProgress) {
			if deps.Progress != nil {
				deps.Progress.Record(identity, DeliveryProgressFromOutbound(identity, update))
			}
		},
	}
	fileResult, downloadErr := outbound.DownloadResumableToFile(ctx, artifactURL, downloadOptions)
	if managed && downloadErr != nil && deps.RefreshManagedURL != nil {
		freshURL, refreshed, refreshErr := deps.RefreshManagedURL(ctx, userID, identity, kind, downloadErr)
		if refreshErr != nil {
			return outbound.ResumableFileResult{}, refreshErr
		}
		if refreshed {
			var err error
			downloadOptions.Headers, err = ImageDownloadHeaders(deps.Repo, deps.DecryptTaskInput, deps.DecryptSetting, deps.ResolveConfig, deps.ProtocolRegistry, userID, identity, kind, freshURL)
			if err != nil {
				return outbound.ResumableFileResult{}, err
			}
			fileResult, downloadErr = outbound.DownloadResumableToFile(ctx, freshURL, downloadOptions)
		}
	}
	if deps.Progress != nil {
		deps.Progress.Clear(identity)
	}
	if downloadErr != nil {
		if errors.Is(downloadErr, outbound.ErrResourceTooLarge) {
			return outbound.ResumableFileResult{}, kernel.BadAuthRequest(fmt.Sprintf("远程资源必须小于 %s", localasset.FormatStorageLimit(limit)))
		}
		if outbound.IsConnectionDrop(downloadErr) {
			return outbound.ResumableFileResult{}, &kernel.AppError{
				Status:    kernel.CodeBadGateway,
				Code:      kernel.CodeBadGateway,
				Reason:    kernel.ReasonBadGateway,
				Message:   outbound.ResumableConnectionDropMessage,
				Retryable: true,
				Cause:     downloadErr,
			}
		}
		return outbound.ResumableFileResult{}, downloadErr
	}
	return fileResult, nil
}

// decodeRemoteVideoArtifactToFile downloads, validates, optionally remuxes
// source audio, and probes a remote video artifact entirely on disk so 1-2 GiB
// videos never enter Go heap memory.
func decodeRemoteVideoArtifactToFile(deps DeliveryMediaDeps, userID, identity, mediaType, artifactURL string, downloadTimeout time.Duration) (localasset.RecoveredArtifact, func(), error) {
	var cleanups []func()
	runCleanups := func() {
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
		cleanups = nil
	}
	kind := strings.TrimSpace(mediaType)
	ctx, finish, contextErr := deps.BeginDownload(userID, identity, downloadTimeout)
	if contextErr != nil {
		return localasset.RecoveredArtifact{}, nil, contextErr
	}
	var retErr error
	defer func() { finish(retErr) }()

	managed, identityErr := ManagedDeliveryArtifact(deps.Repo, deps.DecryptSetting, userID, identity)
	if identityErr != nil {
		retErr = identityErr
		return localasset.RecoveredArtifact{}, nil, retErr
	}
	fileResult, downloadErr := downloadManagedResumableFile(ctx, deps, userID, identity, kind, artifactURL, managed)
	if downloadErr != nil {
		retErr = downloadErr
		return localasset.RecoveredArtifact{}, nil, retErr
	}
	cleanups = append(cleanups, func() { _ = os.Remove(fileResult.Path) })

	finalPath := fileResult.Path
	mimeType := fileResult.MimeType
	head, headErr := outbound.ReadFilePrefix(finalPath, videoHeaderSniffLimit)
	if headErr != nil {
		runCleanups()
		retErr = headErr
		return localasset.RecoveredArtifact{}, nil, retErr
	}
	if managed {
		if err := generation.ValidateVideoArtifact(head, mimeType); err != nil {
			runCleanups()
			retErr = err
			return localasset.RecoveredArtifact{}, nil, retErr
		}
		remuxedPath, remuxCleanup, err := RestoreManagedUpscaleAudioFile(ctx, deps.Repo, deps.DecryptTaskInput, deps.BindRuntime, userID, identity, finalPath)
		if remuxCleanup != nil {
			cleanups = append(cleanups, remuxCleanup)
		}
		if err != nil {
			runCleanups()
			retErr = err
			return localasset.RecoveredArtifact{}, nil, retErr
		}
		if remuxedPath != finalPath {
			finalPath = remuxedPath
			head, headErr = outbound.ReadFilePrefix(finalPath, videoHeaderSniffLimit)
			if headErr != nil {
				runCleanups()
				retErr = headErr
				return localasset.RecoveredArtifact{}, nil, retErr
			}
		}
	}
	kind, mimeType, fileName := resolveArtifactFileMeta(kind, mimeType, fileResult.FileName, head)
	file, err := os.Open(finalPath)
	if err != nil {
		runCleanups()
		retErr = err
		return localasset.RecoveredArtifact{}, nil, retErr
	}
	cleanups = append(cleanups, func() { _ = file.Close() })
	info, err := file.Stat()
	if err != nil {
		runCleanups()
		retErr = err
		return localasset.RecoveredArtifact{}, nil, retErr
	}
	width, height, durationMs := playback.ProbeVideoReader(file, info.Size())
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		runCleanups()
		retErr = err
		return localasset.RecoveredArtifact{}, nil, retErr
	}
	return localasset.RecoveredArtifact{
		Kind:       kind,
		FileName:   fileName,
		MimeType:   mimeType,
		Size:       info.Size(),
		Width:      width,
		Height:     height,
		DurationMs: durationMs,
		Body:       file,
	}, runCleanups, nil
}

func DecodeGenerationArtifact(deps DeliveryMediaDeps, userID, identity, mediaType, artifactURL string, downloadTimeout time.Duration) (kind string, data []byte, mimeType, fileName string, width, height int, durationMs int64, err error) {
	kind = strings.TrimSpace(mediaType)
	switch {
	case strings.HasPrefix(artifactURL, "data:"):
		decodedType, decoded, decodeErr := deps.DecodeDataURL(artifactURL)
		if decodeErr != nil {
			return "", nil, "", "", 0, 0, 0, decodeErr
		}
		mimeType, data = decodedType, decoded
		kind = localasset.NormalizeKind(kind, mimeType)
		fileName = "generated." + localasset.ExtensionFromMimeType(mimeType)
		if kind == "image" {
			width, height = decodeImageDimensions(data)
		}
		if kind == "video" {
			width, height, durationMs = playback.ProbeGeneratedVideoMedia(data)
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	case strings.HasPrefix(artifactURL, "http://") || strings.HasPrefix(artifactURL, "https://"):
		if kind == "video" {
			return "", nil, "", "", 0, 0, 0, errors.New("remote video artifacts must use disk-streaming PersistRemoteGenerationArtifact")
		}
		ctx, finish, contextErr := deps.BeginDownload(userID, identity, downloadTimeout)
		if contextErr != nil {
			return "", nil, "", "", 0, 0, 0, contextErr
		}
		defer func() { finish(err) }()
		managed, identityErr := ManagedDeliveryArtifact(deps.Repo, deps.DecryptSetting, userID, identity)
		if identityErr != nil {
			return "", nil, "", "", 0, 0, 0, identityErr
		}
		fileResult, downloadErr := downloadManagedResumableFile(ctx, deps, userID, identity, kind, artifactURL, managed)
		if downloadErr != nil {
			return "", nil, "", "", 0, 0, 0, downloadErr
		}
		defer os.Remove(fileResult.Path)
		data, err = os.ReadFile(fileResult.Path)
		if err != nil {
			return "", nil, "", "", 0, 0, 0, err
		}
		mimeType = fileResult.MimeType
		if managed && kind == "audio" {
			mimeType, err = generation.ValidateGeneratedAudio(mimeType, data, "")
			if err != nil {
				return "", nil, "", "", 0, 0, 0, err
			}
		}
		if kind == "image" {
			if validationErr := generation.ValidateImageArtifact(data, mimeType); validationErr != nil {
				return "", nil, "", "", 0, 0, 0, validationErr
			}
		}
		kind, mimeType, fileName = resolveArtifactFileMeta(kind, mimeType, fileResult.FileName, data)
		if kind == "image" {
			width, height = decodeImageDimensions(data)
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	default:
		return "", nil, "", "", 0, 0, 0, fmt.Errorf("unsupported generation artifact %q", artifactURL)
	}
}

func isManagedTaskConnection(task model.Task) bool {
	return beeftv.IsManagedTaskInput(task.InputJSON)
}

func ImageDownloadHeaders(
	repo *repository.Repository,
	decryptTaskInput func(string) (string, error),
	decryptSetting func(string) (string, error),
	resolveConfig func(generation.Config) (generation.Config, error),
	registry *protocol.Registry,
	userID, identity, kind, artifactURL string,
) (http.Header, error) {
	if kind != "image" {
		return nil, nil
	}
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, errors.New("generation artifact identity is incomplete")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if isManagedTaskConnection(*task) {
		return nil, nil
	}
	if strings.TrimSpace(task.InputJSON) == "" {
		return nil, nil
	}
	plain, err := decryptTaskInput(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input generation.Input
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return nil, err
	}
	var retained struct {
		Cipher string `json:"imageDeliveryCipher"`
	}
	if err := json.Unmarshal([]byte(plain), &retained); err != nil {
		return nil, err
	}
	if retained.Cipher != "" {
		configJSON, err := decryptSetting(retained.Cipher)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(configJSON), &input.Config); err != nil {
			return nil, err
		}
	}
	if input.Config.CredentialRef == beeftv.CredentialRef || input.Config.ChannelID == beeftv.ChannelID {
		return nil, nil
	}
	if input.Config.BaseURL == "" && input.Config.ChannelID == "" {
		return nil, nil
	}
	config, err := resolveConfig(input.Config)
	if err != nil {
		return nil, err
	}
	if !generation.SameProviderOrigin(config.BaseURL, artifactURL) {
		return nil, nil
	}
	req, err := http.NewRequest(http.MethodGet, artifactURL, nil)
	if err != nil {
		return nil, err
	}
	if registry != nil {
		if adapter, ok := registry.Resolve(config.InterfaceType); ok {
			if auth, ok := adapter.(protocol.MediaAuthAdapter); ok {
				if err := generation.ApplyProtocolAuth(req, config, auth.MediaAuth()); err != nil {
					return nil, err
				}
			} else {
				generation.ApplyAuth(req, config)
			}
		} else {
			generation.ApplyAuth(req, config)
		}
	} else {
		generation.ApplyAuth(req, config)
	}
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return req.Header, nil
}

func ManagedDeliveryArtifact(repo *repository.Repository, decryptSetting func(string) (string, error), userID, identity string) (bool, error) {
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return false, errors.New("generation artifact identity is incomplete")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if isManagedTaskConnection(*task) {
		return true, nil
	}
	var retained struct {
		Cipher string `json:"imageDeliveryCipher"`
	}
	if strings.TrimSpace(task.InputJSON) != "" {
		if err := json.Unmarshal([]byte(task.InputJSON), &retained); err != nil {
			return false, err
		}
	}
	if retained.Cipher != "" {
		plain, err := decryptSetting(retained.Cipher)
		if err != nil {
			return false, err
		}
		var config generation.Config
		if err := json.Unmarshal([]byte(plain), &config); err != nil {
			return false, err
		}
		if config.CredentialRef == beeftv.CredentialRef || config.ChannelID == beeftv.ChannelID {
			return true, nil
		}
		if strings.TrimSpace(config.BaseURL) != "" || strings.TrimSpace(config.APIKey) != "" || strings.TrimSpace(config.ChannelID) != "" {
			return false, nil
		}
	}
	if attempt, err := repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil {
		if attempt.ChannelID == beeftv.ChannelID {
			return true, nil
		}
		if row, err := repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err == nil && row.QueryCipher != "" {
			return true, nil
		}
	}
	return false, nil
}

var (
	artifactDownloadSweepMu   sync.Mutex
	artifactDownloadLastSweep = map[string]time.Time{}
)

func sweepArtifactDownloadsIfDue(dir string) {
	now := time.Now()
	artifactDownloadSweepMu.Lock()
	if last, ok := artifactDownloadLastSweep[dir]; ok && now.Sub(last) < 6*time.Hour {
		artifactDownloadSweepMu.Unlock()
		return
	}
	artifactDownloadLastSweep[dir] = now
	artifactDownloadSweepMu.Unlock()
	outbound.SweepResumableArtifacts(dir, 24*time.Hour)
}

func ArtifactDownloadPartialPath(dataDir, userID, identity string) string {
	dir := filepath.Join(dataDir, "cache", "artifact-downloads")
	sweepArtifactDownloadsIfDue(dir)
	sum := sha256.Sum256([]byte(userID + "\x00" + identity))
	return filepath.Join(dir, hex.EncodeToString(sum[:])+".part")
}

func RefreshManagedArtifactURL(
	ctx context.Context,
	repo *repository.Repository,
	queryManaged func(ctx context.Context, task model.Task) (status string, outputs []beeftv.MediaOutput, managed, legacy bool, err error),
	userID, identity, kind string,
	cause error,
) (string, bool, error) {
	var response *outbound.HTTPStatusError
	if !errors.As(cause, &response) || (response.StatusCode != 401 && response.StatusCode != 403) {
		return "", false, nil
	}
	taskID, rawIndex, ok := strings.Cut(identity, ":")
	index, err := strconv.Atoi(rawIndex)
	if !ok || err != nil || index < 0 {
		return "", false, errors.New("生成结果身份无效")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return "", false, err
	}
	status, outputs, managed, legacy, err := queryManaged(ctx, *task)
	if err != nil || !managed {
		return "", managed, err
	}
	if legacy {
		return "", false, nil
	}
	if status != "completed" || index >= len(outputs) || outputs[index].Kind != kind || outputs[index].URL == "" {
		return "", true, errors.New("原任务结果暂不可用，请稍后继续取回")
	}
	return outputs[index].URL, true, nil
}

func loadManagedAudioTaskInput(
	ctx context.Context,
	repo *repository.Repository,
	decryptTaskInput func(string) (string, error),
	bindRuntime func(context.Context, generation.CallMeta) context.Context,
	userID, identity string,
) (context.Context, generation.Input, bool, error) {
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return ctx, generation.Input{}, false, errors.New("生成结果身份无效")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return ctx, generation.Input{}, false, err
	}
	plain, err := decryptTaskInput(task.InputJSON)
	if err != nil {
		return ctx, generation.Input{}, false, err
	}
	var input generation.Input
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return ctx, generation.Input{}, false, err
	}
	if (input.Upscale == nil && input.SubtitleErase == nil) || input.Mode != "video" {
		return ctx, input, false, nil
	}
	if bindRuntime != nil {
		ctx = bindRuntime(ctx, generation.CallMeta{UserID: userID, TaskID: taskID, TaskType: task.Type})
	}
	return ctx, input, true, nil
}

func RestoreManagedUpscaleAudioFile(
	ctx context.Context,
	repo *repository.Repository,
	decryptTaskInput func(string) (string, error),
	bindRuntime func(context.Context, generation.CallMeta) context.Context,
	userID, identity string,
	outputPath string,
) (string, func(), error) {
	noop := func() {}
	ctx, input, needsRestore, err := loadManagedAudioTaskInput(ctx, repo, decryptTaskInput, bindRuntime, userID, identity)
	if err != nil || !needsRestore {
		return outputPath, noop, err
	}
	if input.SubtitleErase != nil {
		return generation.RestoreSubtitleEraseSourceAudioFile(ctx, input, outputPath)
	}
	return generation.RestoreUpscaleSourceAudioFile(ctx, input, outputPath)
}

func decodeImageDimensions(data []byte) (int, int) {
	config, _, err := image.DecodeConfig(io.LimitReader(bytes.NewReader(data), imageHeaderDecodeLimit))
	if err != nil {
		return 0, 0
	}
	return config.Width, config.Height
}
