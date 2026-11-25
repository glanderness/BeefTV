package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/referencestorage"
	"infinite-canvas/backend/internal/repository"
)

const (
	ContentModerationErrorCode      = "sensitive_words_detected"
	ContentModerationRetryMessage   = "内容未通过安全审核，请修改提示词或参考图后重新生成；原任务不能直接重试"
	SubmissionUncertainRetryMessage = "提交结果尚未确认，请先查询原任务，不要立即重新提交"
	DownloadFailureRetryMessage     = "生成结果下载失败，请先重新加载或查询原任务，不要立即重新提交"
	taskStageRequestNotSent         = "请求尚未提交"
)

type AnalyticsKey struct{}

type AnalyticsContext = CallMeta

func TaskAnalyticsContext(task model.Task) AnalyticsContext {
	metadata := AnalyticsContext{
		UserID:            task.UserID,
		TaskID:            task.ID,
		ProjectID:         task.ProjectID,
		TaskType:          task.Type,
		TraceID:           task.TraceID,
		RequestID:         task.RequestID,
		Capability:        modelcatalog.CapabilityFromTaskType(task.Type),
		Operation:         task.Operation,
		Model:             task.Model,
		ProviderRequestID: task.ProviderRequestID,
	}
	var input struct {
		Mode   string `json:"mode"`
		Config Config `json:"config"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) == nil {
		metadata.ChannelID = firstNonEmpty(input.Config.ChannelID, modelcatalog.SystemChannelIDFromBaseURL(input.Config.BaseURL))
		metadata.Model = firstNonEmpty(input.Config.ChannelModelKey, input.Config.Model, metadata.Model)
		metadata.VideoSeconds, _ = strconv.Atoi(input.Config.VideoSeconds)
		if normalized := modelcatalog.NormalizeCapability(input.Mode); normalized != "" {
			metadata.Capability = normalized
		}
	}
	return metadata
}

func WithProviderRequestKind(ctx context.Context, requestKind string) context.Context {
	metadata, ok := ctx.Value(AnalyticsKey{}).(AnalyticsContext)
	if !ok {
		return WithRequestKind(ctx, requestKind)
	}
	metadata.RequestKind = requestKind
	ctx = context.WithValue(ctx, AnalyticsKey{}, metadata)
	return WithRequestKind(ctx, requestKind)
}

func CanonicalCallMeta(ctx context.Context) CallMeta {
	if runtime, ok := RuntimeFromContext(ctx); ok {
		if strings.TrimSpace(runtime.Call.UserID) != "" || strings.TrimSpace(runtime.Call.TaskID) != "" || strings.TrimSpace(runtime.Call.RequestKind) != "" || runtime.Call.ConcurrencyLimit != 0 {
			return runtime.Call
		}
	}
	metadata, _ := ctx.Value(AnalyticsKey{}).(AnalyticsContext)
	return metadata
}

func DefiniteMidjourneyCountRejection(err error) bool {
	var upstream HTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode < 400 {
		return false
	}
	var body struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			TaskID  string `json:"task_id"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil || body.TaskID != "" || body.ID != "" || body.Error.TaskID != "" {
		return false
	}
	return body.Error.Code == "invalid_request" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(body.Error.Message)), "midjourney generates four images per request; n must be 4 or omitted")
}

func ClassifyTaskFailure(err error) Failure {
	if err == nil {
		return ClassifyError(nil)
	}
	failure := ApplyAppFailureWrappers(err, ClassifyError(err))
	if failure.Category == CategoryInvalidParams && !failure.Uncertain && DefiniteMidjourneyCountRejection(err) {
		failure.Reason = "Midjourney 需要一次请求生成 4 张图片"
		failure.Action = "请重新选择 Midjourney 模型，使用固定四张设置后重试"
	}
	return failure
}

func ApplyAppFailureWrappers(err error, failure Failure) Failure {
	var imageRecovery ImageRecoveryError
	if errors.As(err, &imageRecovery) {
		var httpErr HTTPError
		if errors.As(imageRecovery.Cause, &httpErr) && httpErr.StatusCode == 524 {
			return ClassifyHTTP(httpErr.StatusCode, httpErr.Status, httpErr.Body)
		}
		failure.Category = CategorySubmissionUncertain
		failure.Uncertain = true
		failure.Reason = "图片结果尚未确认，自动恢复已停止"
		failure.Action = "请保留任务记录并联系支持查询结果，不要重复提交"
		var preparation ImagePreparationError
		if errors.As(err, &preparation) {
			failure.Reason = "图片提交记录无法确认，自动恢复已停止"
		}
		return failure
	}
	var preparation ImagePreparationError
	if errors.As(err, &preparation) {
		failure = ClassifyError(preparation.Cause)
		failure.Uncertain, failure.Retryable = false, false
		failure.Reason = preparation.Error()
		failure.Action = "请保留排查信息并联系支持检查本地任务记录"
		return failure
	}
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		failure.Category = CategorySubmissionUncertain
		failure.Uncertain, failure.Retryable = true, false
		failure.Reason, failure.Action = "", ""
		return failure
	}
	var download VideoDownloadError
	if errors.As(err, &download) {
		failure = WithDownloadFailure(failure, download.TaskID)
	}
	var persist VideoPersistError
	if errors.As(err, &persist) {
		failure.TaskID = firstNonEmpty(failure.TaskID, persist.TaskID)
	}
	var pending StatePendingError
	if errors.As(err, &pending) {
		failure.Category = CategorySubmissionUncertain
		failure.Uncertain = true
		failure.TaskID = firstNonEmpty(failure.TaskID, pending.TaskID)
		failure.Reason = ""
		failure.Action = ""
	}
	var circuit CircuitOpenError
	if errors.As(err, &circuit) {
		return CircuitOpenFailure()
	}
	if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
		failure = WithConcurrencyFailure(failure)
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) && appErr != nil {
		classified := ClassifyAppError(appErr.Status, appErr.Code, string(appErr.Reason), appErr.Message)
		if failure.Category == CategoryUnknown || classified.Category != CategoryUnknown {
			failure = classified
		}
	}
	return failure
}

func PersistableTaskFailureMessage(err error) string {
	return ClassifyTaskFailure(err).UserMessage()
}

func TaskFailureErrorCode(err error) string {
	return ClassifyTaskFailure(err).ErrorCode()
}

func PersistedFailureErrorCode(message string, stage string) string {
	if stage == taskStageRequestNotSent {
		return string(CategoryRequestNotSent)
	}
	failure := ClassifyText(message)
	if stage == "submission_unknown" {
		return string(CategorySubmissionUncertain)
	}
	return failure.ErrorCode()
}

func PersistedFailureBlocksRetry(message, stage, errorCode string) bool {
	if stage == taskStageRequestNotSent {
		return false
	}
	if stage == "submission_unknown" {
		return true
	}
	return PersistedFailure(message, errorCode).BlocksManualRetry()
}

// PersistedTaskCategory is the category a stored task failure carries; the
// unconfirmed-submission stage stays a stage fact.
func PersistedTaskCategory(message, stage, errorCode string) FailureCategory {
	if stage == "submission_unknown" {
		return CategorySubmissionUncertain
	}
	if strings.TrimSpace(errorCode) != "" {
		return PersistedFailure(message, errorCode).Category
	}
	return ClassifyTaskFailure(errors.New(message)).Category
}

// PersistedFailure is the conclusion saved when the task failed. Only legacy
// rows without a saved category fall back to classifying the stored text.
func PersistedFailure(message, errorCode string) Failure {
	if code := strings.TrimSpace(errorCode); code != "" && strings.TrimSpace(message) != "" {
		return normalizeFailure(Failure{Category: FailureCategory(code)})
	}
	return ClassifyText(message)
}

func IsContentModerationFailure(value string) bool {
	if strings.Contains(strings.ToLower(value), ContentModerationErrorCode) {
		return true
	}
	return ClassifyTaskFailure(errors.New(value)).IsModeration()
}

var providerProgressKeys = []string{"progress", "progresspercent", "progresspercentage", "percent", "percentage", "completion", "completionpercent"}

var providerProgressContainers = []string{"data", "result", "task", "output", "operation", "response", "meta", "metadata"}

func SyncProviderTaskProgress(repo *repository.Repository, taskID string, responseBody []byte) {
	if repo == nil || strings.TrimSpace(taskID) == "" {
		return
	}
	progress, ok := ProviderProgressFromResponse(responseBody)
	if !ok {
		return
	}
	if err := repo.UpdateTaskProviderProgress(taskID, progress); err != nil {
		log.Printf("provider progress sync failed: task_id=%s error=%v", taskID, err)
	}
}

func ProviderProgressFromResponse(responseBody []byte) (int, bool) {
	if len(responseBody) == 0 {
		return 0, false
	}
	var payload any
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return 0, false
	}
	return findProviderProgress(payload, 0)
}

func findProviderProgress(value any, depth int) (int, bool) {
	if depth > 8 {
		return 0, false
	}
	switch current := value.(type) {
	case map[string]any:
		for _, wantedKey := range providerProgressKeys {
			for key, candidate := range current {
				if normalizeProviderProgressKey(key) != wantedKey {
					continue
				}
				if progress, ok := normalizeProviderProgressValue(candidate); ok {
					return progress, true
				}
			}
		}
		for _, wantedContainer := range providerProgressContainers {
			for key, nested := range current {
				if normalizeProviderProgressKey(key) != wantedContainer {
					continue
				}
				if progress, ok := findProviderProgress(nested, depth+1); ok {
					return progress, true
				}
			}
		}
	case []any:
		for _, nested := range current {
			if progress, ok := findProviderProgress(nested, depth+1); ok {
				return progress, true
			}
		}
	}
	return 0, false
}

func normalizeProviderProgressValue(value any) (int, bool) {
	var number float64
	explicitPercent := false
	switch current := value.(type) {
	case float64:
		number = current
	case string:
		text := strings.TrimSpace(current)
		if text == "" {
			return 0, false
		}
		explicitPercent = strings.HasSuffix(text, "%")
		text = strings.TrimSpace(strings.TrimSuffix(text, "%"))
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 100 {
		return 0, false
	}
	if !explicitPercent && number > 0 && number < 1 {
		number *= 100
	}
	return int(math.Round(number)), true
}

func normalizeProviderProgressKey(value string) string {
	return strings.NewReplacer("_", "", "-", "", ".", "", " ", "").Replace(strings.ToLower(strings.TrimSpace(value)))
}

func WriteMediaPart(writer *multipart.Writer, field string, media Media) error {
	return writeMediaPart(writer, field, media)
}

func RecordProviderRequest(repo *repository.Repository, logCall func(model.ApiCallLog) error, req *http.Request, startedAt time.Time, statusCode int, responseBody []byte, requestErr error) {
	if req == nil || logCall == nil {
		return
	}
	call := CanonicalCallMeta(req.Context())
	status := model.ApiCallStatusSucceeded
	errorCode := ""
	errorText := ""
	if requestErr != nil || statusCode < 200 || statusCode >= 300 {
		status = model.ApiCallStatusFailed
		errorCode, errorText = ProviderRequestErrorDetails(requestErr)
	} else if businessCode, businessMessage, failed := ResponseBusinessFailure(responseBody); failed {
		status = model.ApiCallStatusFailed
		errorCode = businessCode
		errorText = businessMessage
	}
	requestKind := ProviderRequestKind(req.Method, req.URL.Path)
	if call.RequestKind != "" {
		requestKind = call.RequestKind
	}
	if status == model.ApiCallStatusSucceeded && (requestKind == "create" || requestKind == "poll") && (call.Capability == "image" || call.Capability == "video") {
		SyncProviderTaskProgress(repo, call.TaskID, responseBody)
	}
	if call.TaskID != "" && call.Capability == "video" && (requestKind == "create" || requestKind == "poll") && repo != nil {
		settlement := ExtractBeefTVVideoSettlementBytes(responseBody)
		if settlement.UsageState != nil || settlement.ReconcileDeadline != nil {
			_ = repo.UpdateTaskBeefVideoSettlement(call.TaskID, settlement.UsageState, settlement.ReconcileDeadline)
		}
	}
	apiFormat := "openai"
	if req.Header.Get("x-goog-api-key") != "" {
		apiFormat = "gemini"
	}
	callLog := model.ApiCallLog{
		UserID: call.UserID, TraceID: call.TraceID, RequestID: call.RequestID, ChannelID: call.ChannelID, TaskID: call.TaskID,
		Source: "backend-task", Capability: call.Capability, Operation: call.Operation,
		RequestKind: requestKind,
		APIFormat:   apiFormat, Method: req.Method, Path: req.URL.Path, Model: call.Model,
		Status: status, StatusCode: statusCode, DurationMs: time.Since(startedAt).Milliseconds(),
		ErrorCode: errorCode, Error: errorText, ConcurrencyLimit: call.ConcurrencyLimit, UpstreamURL: req.URL.Scheme + "://" + req.URL.Host + req.URL.Path,
		ProviderRequestID: call.ProviderRequestID, RequestContentType: req.Header.Get("Content-Type"), RequestBody: platform.RequestPayloadForLog(req), ResponseBody: platform.SanitizeAPICallPayload(responseBody, ""),
	}
	if code, message := platform.ChannelSlotFailureDetails(requestErr); code != "" {
		callLog.ErrorCode = code
		callLog.Error = message
	}
	if requestKind == "create" && call.Capability == "video" {
		callLog.VideoSeconds = call.VideoSeconds
		if callLog.VideoSeconds <= 0 {
			if strings.Contains(strings.ToLower(call.Model), "seedance") || strings.Contains(req.URL.Path, "/contents/generations/tasks") {
				callLog.VideoSeconds = 5
			} else {
				callLog.VideoSeconds = 6
			}
		}
	}
	EnrichAPICallLog(&callLog, responseBody)
	if call.Capability == "video" && requestKind != "create" && strings.TrimSpace(call.ProviderRequestID) != "" {
		callLog.ProviderRequestID = call.ProviderRequestID
	}
	_ = logCall(callLog)
}

func ProviderRequestErrorDetails(err error) (string, string) {
	if err == nil {
		return "", ""
	}
	if errors.Is(err, context.Canceled) {
		return "request_cancelled", "任务取消，中断上游请求"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "upstream_timeout", "等待上游响应超时"
	}
	return "", SafeProviderLogError(err)
}

func SafeProviderLogError(err error) string {
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("上游 HTTP %d", httpErr.StatusCode)
	}
	return truncateRunes(err.Error(), 500)
}

func ProviderRequestKind(method string, path string) string {
	if method == http.MethodGet {
		if strings.HasSuffix(strings.TrimRight(path, "/"), "/content") || strings.Contains(path, "/download") {
			return "download"
		}
		return "poll"
	}
	if strings.Contains(path, "repair") {
		return "repair"
	}
	return "create"
}

func PrepareBeefTVSeedanceReferencesForUser(ctx context.Context, userID string, input *Input, openResource func(userID, resourceID string) (*model.Resource, io.ReadCloser, error)) error {
	if input == nil || input.Mode != "video" || !IsBeefTVSeedancePreuploadConfig(ctx, input.Config) {
		return nil
	}
	return PrepareBeefTVVideoReferences(ctx, input.Config, input, func(kind string, media Media) ([]byte, string, bool, error) {
		return ReadBeefTVSeedanceMedia(userID, kind, media, openResource)
	})
}

func ReadBeefTVSeedanceMedia(userID string, kind string, media Media, openResource func(userID, resourceID string) (*model.Resource, io.ReadCloser, error)) ([]byte, string, bool, error) {
	if SkipBeefTVSeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := DecodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if !strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", true, nil
	}
	if media.Bytes > 0 {
		if err := ValidateBeefTVSeedanceMediaSize(kind, media.Bytes); err != nil {
			return nil, "", false, err
		}
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	resource, body, err := openResource(userID, resourceID)
	if err != nil {
		return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	defer body.Close()
	limit := BeefTVSeedanceKindMaxBytes(kind)
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
}

type localReferenceStoragePort struct {
	localMode    func() bool
	dataDir      string
	openResource func(userID, resourceID string) (*model.Resource, io.ReadCloser, error)
}

func NewReferenceStoragePort(localMode func() bool, dataDir string, openResource func(userID, resourceID string) (*model.Resource, io.ReadCloser, error)) ReferenceStoragePort {
	return localReferenceStoragePort{localMode: localMode, dataDir: dataDir, openResource: openResource}
}

func (p localReferenceStoragePort) Enabled() (bool, error) {
	if p.localMode == nil || !p.localMode() {
		return false, nil
	}
	config, err := referencestorage.Load(p.dataDir)
	return config.Enabled, err
}

func (p localReferenceStoragePort) Upload(ctx context.Context, userID, resourceID string) (string, error) {
	if p.localMode == nil || !p.localMode() {
		return "", errors.New("当前工作区未启用本地素材上传")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	_, body, err := p.openResource(userID, resourceID)
	if err != nil {
		return "", errors.New("参考素材无法读取，请检查素材是否仍在当前工作区")
	}
	defer body.Close()
	return p.uploadReader(ctx, body)
}

func (p localReferenceStoragePort) UploadBytes(ctx context.Context, data []byte) (string, error) {
	return p.uploadReader(ctx, bytes.NewReader(data))
}

func (p localReferenceStoragePort) uploadReader(ctx context.Context, body io.Reader) (string, error) {
	if p.localMode == nil || !p.localMode() {
		return "", errors.New("当前工作区未启用本地素材上传")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	config, err := referencestorage.Load(p.dataDir)
	if err != nil {
		return "", errors.New("参考素材对象存储配置无法读取")
	}
	temp := filepath.Join(p.dataDir, "cache", "tmp")
	if err := os.MkdirAll(temp, 0700); err != nil {
		return "", errors.New("无法准备参考素材，请检查本地磁盘")
	}
	file, err := os.CreateTemp(temp, "reference-generation-*")
	if err != nil {
		return "", errors.New("无法准备参考素材，请检查本地磁盘")
	}
	defer os.Remove(file.Name())
	_, copyErr := io.Copy(file, body)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return "", errors.New("无法保存临时参考素材，请检查本地磁盘")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return referencestorage.Upload(ctx, config, file.Name(), ReferenceUploadObserver(ctx, "参考素材"))
}

func EnsureFailedProviderAttemptLogged(repo *repository.Repository, task model.Task, taskErr error, decryptInput func(string) (string, error), userFacingMessage func(error) string, logCall func(model.ApiCallLog) error) {
	if repo == nil || strings.TrimSpace(task.ID) == "" || taskErr == nil {
		return
	}
	hasLog, err := repo.HasAPICallLogForTask(task.ID)
	if err != nil {
		log.Printf("provider attempt log lookup failed: task_id=%s error=%v", task.ID, err)
		return
	}
	if hasLog {
		return
	}
	decodedTask := task
	if decryptInput != nil {
		if decrypted, decryptErr := decryptInput(task.InputJSON); decryptErr == nil {
			decodedTask.InputJSON = decrypted
		}
	}
	metadata := TaskAnalyticsContext(decodedTask)
	now := time.Now()
	startedAt := now
	if task.StartedAt != nil && !task.StartedAt.IsZero() {
		startedAt = *task.StartedAt
	}
	path := "/task/provider-preflight"
	errorCode := "request_not_sent"
	statusCode := 0
	var httpErr HTTPError
	if errors.As(taskErr, &httpErr) {
		path = "/task/provider-request"
		errorCode = "provider_request_unlogged"
		statusCode = httpErr.StatusCode
	} else if strings.TrimSpace(metadata.ProviderRequestID) != "" {
		path = "/task/provider-state"
		errorCode = "provider_state_unlogged"
	}
	errMsg := ""
	if userFacingMessage != nil {
		errMsg = truncateRunes(userFacingMessage(taskErr), 2_000)
	}
	callLog := model.ApiCallLog{
		UserID:            metadata.UserID,
		TraceID:           metadata.TraceID,
		RequestID:         metadata.RequestID,
		ChannelID:         metadata.ChannelID,
		TaskID:            metadata.TaskID,
		Source:            "backend-task",
		Capability:        metadata.Capability,
		Operation:         metadata.Operation,
		RequestKind:       "create",
		APIFormat:         "internal",
		Method:            "INTERNAL",
		Path:              path,
		Model:             metadata.Model,
		Status:            model.ApiCallStatusFailed,
		StatusCode:        statusCode,
		DurationMs:        now.Sub(startedAt).Milliseconds(),
		ProviderRequestID: metadata.ProviderRequestID,
		ErrorCode:         errorCode,
		Error:             errMsg,
		StartedAt:         startedAt,
		CreatedAt:         now,
	}
	if logCall != nil {
		if err := logCall(callLog); err != nil {
			log.Printf("provider attempt log write failed: task_id=%s error=%v", task.ID, err)
		}
	}
}
