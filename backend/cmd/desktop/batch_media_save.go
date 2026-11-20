package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"infinite-canvas/backend/internal/bootstrap"
)

const (
	maxOwnedMediaBatchItems = 5000
	maxBatchCollisionTries  = 10_000
	batchDirTokenTTL        = 5 * time.Minute
)

type OwnedMediaBatchItem struct {
	FileName   string `json:"fileName"`
	ResourceID string `json:"resourceId,omitempty"`
	Data       []byte `json:"data,omitempty"`
}

type OwnedMediaBatchFailure struct {
	FileName string `json:"fileName"`
	Reason   string `json:"reason"`
}

type OwnedMediaBatchResult struct {
	Saved     int                      `json:"saved"`
	Failed    int                      `json:"failed"`
	Cancelled bool                     `json:"cancelled"`
	Directory string                   `json:"directory,omitempty"`
	Failures  []OwnedMediaBatchFailure `json:"failures,omitempty"`
}

// ChooseOwnedMediaBatchDirectory prompts once for a target directory and returns
// an opaque single-use token so the frontend can prepare external items after
// user confirmation without ever passing arbitrary filesystem paths to Go.
func (a *DesktopApp) ChooseOwnedMediaBatchDirectory() (string, error) {
	ctx, err := a.dialogContext()
	if err != nil {
		return "", err
	}
	a.batchSaveMu.Lock()
	defer a.batchSaveMu.Unlock()

	chosenDir, err := a.promptSaveDirectory(ctx)
	if err != nil {
		return "", err
	}
	trimmedDir := strings.TrimSpace(chosenDir)
	if trimmedDir == "" {
		return "", nil
	}
	if err := ctx.Err(); err != nil {
		return "", errors.New("应用已关闭，无法保存文件")
	}
	cleanDir, err := validateBatchDirectory(trimmedDir)
	if err != nil {
		return "", err
	}
	token, err := generateBatchDirToken()
	if err != nil {
		return "", errors.New("无法创建保存会话，请重试")
	}
	a.mu.Lock()
	a.batchDirToken = token
	a.batchDirPath = cleanDir
	a.batchDirExpiresAt = time.Now().Add(batchDirTokenTTL)
	a.mu.Unlock()
	return token, nil
}

// SaveOwnedMediaBatch streams owned local resources directly on disk without
// routing media bytes through WebView2. Passing an empty dirToken prompts for a
// target directory natively; passing a token from ChooseOwnedMediaBatchDirectory
// consumes that one-time selection.
func (a *DesktopApp) SaveOwnedMediaBatch(items []OwnedMediaBatchItem, dirToken string) (OwnedMediaBatchResult, error) {
	if len(items) == 0 || len(items) > maxOwnedMediaBatchItems {
		return OwnedMediaBatchResult{}, errors.New("批量保存的文件数量无效")
	}
	inlineBytes := 0
	for _, item := range items {
		inlineBytes += len(item.Data)
		if inlineBytes > bootstrap.MaxOwnedArtifactBytes {
			return OwnedMediaBatchResult{}, errors.New("本地附加文件过大，请分批保存后再试")
		}
	}

	ctx, err := a.dialogContext()
	if err != nil {
		return OwnedMediaBatchResult{}, err
	}

	a.batchSaveMu.Lock()
	defer a.batchSaveMu.Unlock()

	cleanDir, cancelled, err := a.resolveBatchDirectory(ctx, dirToken)
	if err != nil {
		return OwnedMediaBatchResult{}, err
	}
	if cancelled {
		return OwnedMediaBatchResult{Cancelled: true}, nil
	}

	usedLower := make(map[string]struct{}, len(items))
	result := OwnedMediaBatchResult{Directory: cleanDir}
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return result, errors.New("应用已关闭，无法保存文件")
		}
		sanitized := bootstrap.SanitizeSaveFileName(item.FileName)
		resourceID := strings.TrimSpace(item.ResourceID)
		hasResource := resourceID != ""
		hasData := len(item.Data) > 0
		if hasResource == hasData {
			result.Failed++
			result.Failures = append(result.Failures, OwnedMediaBatchFailure{
				FileName: sanitized,
				Reason:   "缺少可保存的本地内容",
			})
			continue
		}
		writeErr := a.writeBatchItemExclusive(cleanDir, sanitized, resourceID, item.Data, usedLower)
		if writeErr != nil {
			result.Failed++
			result.Failures = append(result.Failures, OwnedMediaBatchFailure{
				FileName: sanitized,
				Reason:   writeErr.Error(),
			})
			continue
		}
		result.Saved++
	}
	return result, nil
}

func (a *DesktopApp) resolveBatchDirectory(ctx context.Context, dirToken string) (string, bool, error) {
	trimmedToken := strings.TrimSpace(dirToken)
	if trimmedToken != "" {
		now := time.Now()
		a.mu.Lock()
		expired := !a.batchDirExpiresAt.IsZero() && now.After(a.batchDirExpiresAt)
		matched := !expired && a.batchDirToken != "" && a.batchDirToken == trimmedToken
		chosen := a.batchDirPath
		if matched || expired {
			a.batchDirToken = ""
			a.batchDirPath = ""
			a.batchDirExpiresAt = time.Time{}
		}
		a.mu.Unlock()
		if !matched {
			return "", false, errors.New("保存文件夹授权已失效，请重新选择")
		}
		cleanDir, err := validateBatchDirectory(chosen)
		if err != nil {
			return "", false, err
		}
		return cleanDir, false, nil
	}

	chosenDir, err := a.promptSaveDirectory(ctx)
	if err != nil {
		return "", false, err
	}
	trimmedDir := strings.TrimSpace(chosenDir)
	if trimmedDir == "" {
		return "", true, nil
	}
	if err := ctx.Err(); err != nil {
		return "", false, errors.New("应用已关闭，无法保存文件")
	}
	cleanDir, err := validateBatchDirectory(trimmedDir)
	if err != nil {
		return "", false, err
	}
	return cleanDir, false, nil
}

func (a *DesktopApp) writeBatchItemExclusive(
	cleanDir string,
	sanitized string,
	resourceID string,
	data []byte,
	usedLower map[string]struct{},
) error {
	for suffix := 0; suffix < maxBatchCollisionTries; suffix++ {
		candidate := sanitized
		if suffix > 0 {
			candidate = bootstrap.AppendUniqueSaveFileSuffix(sanitized, suffix)
		}
		lower := strings.ToLower(candidate)
		if _, exists := usedLower[lower]; exists {
			continue
		}
		dest := filepath.Join(cleanDir, candidate)
		if filepath.Dir(dest) != cleanDir {
			return errors.New("无法写入所选位置")
		}
		var writeErr error
		if resourceID != "" {
			writeErr = a.copyMediaExclusive(resourceID, dest)
		} else {
			writeErr = bootstrap.WriteOwnedArtifactExclusive(dest, data)
		}
		if errors.Is(writeErr, os.ErrExist) {
			usedLower[lower] = struct{}{}
			continue
		}
		if writeErr != nil {
			return writeErr
		}
		usedLower[lower] = struct{}{}
		return nil
	}
	return errors.New("目标文件夹内同名文件过多，请更换文件夹重试")
}

func (a *DesktopApp) promptSaveDirectory(ctx context.Context) (string, error) {
	a.mu.RLock()
	choose := a.chooseSaveDir
	a.mu.RUnlock()
	if choose != nil {
		return choose(ctx)
	}
	options := wailsruntime.OpenDialogOptions{
		Title:                "选择批量保存文件夹",
		CanCreateDirectories: true,
	}
	if downloadsDir := a.targetDownloadsDir(); downloadsDir != "" {
		options.DefaultDirectory = downloadsDir
	}
	return wailsruntime.OpenDirectoryDialog(ctx, options)
}

func validateBatchDirectory(trimmedDir string) (string, error) {
	cleanDir := filepath.Clean(trimmedDir)
	info, statErr := os.Stat(cleanDir)
	if statErr != nil || !info.IsDir() {
		return "", errors.New("所选保存文件夹不可用")
	}
	return cleanDir, nil
}

func generateBatchDirToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
