package generation

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/referencestorage"
)

type taskRequestEvidenceKey struct{}

type RequestEvidenceRecorder struct {
	mu          sync.Mutex
	diagnostics model.TaskFailureDiagnostics
}

func WithTaskRequestEvidence(ctx context.Context, previous ...*model.TaskFailureDiagnostics) (context.Context, *RequestEvidenceRecorder) {
	r := &RequestEvidenceRecorder{diagnostics: model.TaskFailureDiagnostics{Source: "unknown", Version: buildinfo.Current().Version, Platform: runtime.GOOS + "/" + runtime.GOARCH}}
	if len(previous) > 0 && previous[0] != nil {
		prior := SanitizeTaskDiagnostics(previous[0])
		r.diagnostics.Requests, r.diagnostics.OmittedRequests, r.diagnostics.Input = prior.Requests, prior.OmittedRequests, prior.Input
	}
	return context.WithValue(ctx, taskRequestEvidenceKey{}, r), r
}

func TaskRequestRecorder(ctx context.Context) *RequestEvidenceRecorder {
	r, _ := ctx.Value(taskRequestEvidenceKey{}).(*RequestEvidenceRecorder)
	return r
}

func (r *RequestEvidenceRecorder) Snapshot(completed bool) *model.TaskFailureDiagnostics {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.diagnostics.ExecutionResult = "failed"
	if completed {
		r.diagnostics.ExecutionResult = "completed"
	}
	return SanitizeTaskDiagnostics(&r.diagnostics)
}

func RecordTaskDiagnosticInput(ctx context.Context, input Input) {
	r := TaskRequestRecorder(ctx)
	if r == nil {
		return
	}
	quality := input.Config.Quality
	if input.Mode == "video" {
		quality = firstNonEmpty(input.Config.Quality, input.Config.VQuality)
	}
	d := &model.TaskDiagnosticInput{Protocol: input.Config.InterfaceType, Model: input.Config.Model, Size: input.Config.Size, Quality: quality, Count: input.Config.Count,
		PromptChars: utf8.RuneCountInString(input.Prompt), ImageCount: len(input.ReferenceImages), VideoCount: len(input.ReferenceVideos), AudioCount: len(input.ReferenceAudios)}
	for i, media := range input.ReferenceImages {
		if i == 16 {
			break
		}
		d.Images = append(d.Images, model.TaskDiagnosticMedia{Bytes: media.Bytes, Width: media.Width, Height: media.Height})
	}
	if input.ImageCapability != nil {
		d.ImageLimitsRecorded = true
		d.MaxImages, d.MaxImageBytes = input.ImageCapability.References.MaxImages, input.ImageCapability.References.MaxImageBytes
	}
	r.mu.Lock()
	r.diagnostics.Input = d
	r.mu.Unlock()
}

func RecordTaskRequestEvidence(req *http.Request, evidence model.TaskRequestEvidence, body []byte, err error) {
	r := TaskRequestRecorder(req.Context())
	if r == nil {
		return
	}
	evidence.Method = req.Method
	evidence.Operation = "other"
	switch {
	case strings.HasSuffix(req.URL.Path, "/images/edits"):
		evidence.Operation = "image_edit"
	case strings.HasSuffix(req.URL.Path, "/images/generations"):
		evidence.Operation = "image_generate"
	case req.Method == http.MethodGet:
		evidence.Operation = "query_or_download"
	case req.Method == http.MethodPost:
		evidence.Operation = "submit"
	}
	evidence.RequestBytes = req.ContentLength
	reference, isReference := ReferenceUploadFromContext(req.Context())
	if isReference {
		evidence.Operation = "reference_" + reference.Stage
		evidence.Attempt = reference.Attempt
		evidence.Summary = reference.Label()
	}
	responseLimited := evidence.Outcome == "response_limit"
	evidence.Outcome = "response_received"
	if err != nil {
		evidence.Outcome = "transport_error"
		if evidence.HTTPStatus >= 400 {
			evidence.Outcome = "http_error"
		}
		if errors.Is(err, context.Canceled) {
			evidence.Outcome = "cancelled"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			evidence.Outcome = "timeout"
		}
		if !evidence.Dispatched && !errors.Is(err, context.Canceled) {
			evidence.Outcome = "not_dispatched"
		}
		failure := ClassifyTaskFailure(err)
		evidence.Summary = firstNonEmpty(failure.ProviderMessage, err.Error())
		evidence.ProviderCode = failure.ProviderCode
		evidence.RequestID = firstNonEmpty(failure.RequestID, evidence.RequestID)
	} else if _, _, failed := ResponseBusinessFailure(body); failed {
		evidence.Outcome = "business_error"
		failure := ClassifyText(string(body))
		evidence.ProviderCode, evidence.Summary = failure.ProviderCode, firstNonEmpty(failure.ProviderMessage, failure.UserMessage())
		evidence.RequestID = firstNonEmpty(failure.RequestID, evidence.RequestID)
	}
	if started, parseErr := time.Parse(time.RFC3339Nano, evidence.StartedAt); parseErr == nil {
		evidence.DurationMS = time.Since(started).Milliseconds()
	}
	if responseLimited {
		evidence.Outcome = "response_limit"
	}
	if isReference && err != nil {
		var upload *ReferenceUploadError
		if errors.As(err, &upload) {
			evidence.ProviderCode, evidence.RequestID = upload.Code, upload.RequestID
			evidence.Summary = upload.Error()
		} else {
			evidence.Summary = reference.Label() + "：" + DiagnosticSummary(err.Error())
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.diagnostics.Requests) == 8 {
		r.diagnostics.Requests = append(r.diagnostics.Requests[:1], r.diagnostics.Requests[2:]...)
		r.diagnostics.OmittedRequests++
	}
	r.diagnostics.Requests = append(r.diagnostics.Requests, evidence)
}

func CaptureTaskFailureDiagnostics(task *model.Task, err error, source string) {
	if err == nil {
		return
	}
	failure := ClassifyTaskFailure(err)
	d := &model.TaskFailureDiagnostics{Source: source, Summary: firstNonEmpty(failure.ProviderMessage, err.Error()),
		RequestID: failure.RequestID, ProviderTaskID: failure.TaskID, Param: failure.Param,
		Stage: task.Stage, CapturedAt: time.Now().Format(time.RFC3339Nano)}
	d.Version, d.Platform = buildinfo.Current().Version, runtime.GOOS+"/"+runtime.GOARCH
	if prior := task.FailureDiagnostics; prior != nil {
		d.Requests, d.OmittedRequests, d.Input, d.ExecutionResult = prior.Requests, prior.OmittedRequests, prior.Input, prior.ExecutionResult
	}
	if source == "local_result" {
		d.Stage = "本地结果处理"
		if failure.Category == CategoryLocalDiskFull {
			d.Stage = "保存生成结果（磁盘空间不足）"
		}
	}
	if len(d.Requests) > 0 && d.Requests[len(d.Requests)-1].Outcome == "response_limit" {
		last := d.Requests[len(d.Requests)-1]
		d.Source, d.Stage, d.RequestID, d.HTTPStatus = "local_response", "本地响应大小校验", last.RequestID, last.HTTPStatus
	}
	var httpErr HTTPError
	var managedHTTP *beeftv.MediaHTTPError
	var managedTask *beeftv.MediaTaskError
	var payload PayloadError
	var appErr *kernel.AppError
	var upload *ReferenceUploadError
	var storagePrep ReferenceStoragePreparationError
	var dns *outbound.DNSResolutionError
	var download VideoDownloadError
	var persist VideoPersistError
	switch {
	case errors.As(err, &persist):
		d.Source, d.Stage, d.Summary = "local_result", "保存视频结果", persist.Error()
	case errors.As(err, &upload):
		d.Source, d.Stage, d.Summary = "reference_upload", upload.Meta.Label(), upload.Error()
		d.FailedOperation, d.TransportPhase = "reference_"+upload.Meta.Stage, upload.TransportPhase
		d.HTTPStatus, d.ProviderCode, d.RequestID = upload.HTTPStatus, upload.Code, upload.RequestID
	case errors.As(err, &storagePrep):
		d.Source, d.Stage = "reference_upload", "参考素材上传"
		var rejection referencestorage.UploadRejectionError
		if errors.As(storagePrep.Cause, &rejection) {
			d.HTTPStatus, d.ProviderCode, d.Summary = rejection.StatusCode, rejection.Code, rejection.Error()
		} else {
			d.Summary = DiagnosticSummary(err.Error())
		}
	case errors.As(err, &dns):
		d.Source, d.TransportPhase = "local_network", "dns"
		d.Stage = "解析模型服务域名"
		if errors.As(err, &download) || task.Stage == "正在取回生成结果" {
			d.Stage = "取回生成结果（DNS 解析）"
		} else if task.ProviderRequestID != "" {
			d.Stage = "查询原任务（DNS 解析）"
		}
	case errors.As(err, &httpErr):
		d.Source, d.HTTPStatus, d.ProviderCode = "upstream_http", httpErr.StatusCode, failure.ProviderCode
		d.RequestID = firstNonEmpty(failure.RequestID, httpErr.RequestID)
		var recoveryErr ImageRecoveryError
		if errors.As(err, &recoveryErr) {
			upstream := ClassifyHTTP(httpErr.StatusCode, "", httpErr.Body)
			d.Summary = firstNonEmpty(upstream.ProviderMessage, upstream.UserMessage())
		}
	case errors.As(err, &managedHTTP):
		d.Source, d.HTTPStatus, d.ProviderCode = "upstream_http", managedHTTP.StatusCode, failure.ProviderCode
		d.RequestID = firstNonEmpty(failure.RequestID, managedHTTP.RequestID)
	case errors.As(err, &managedTask):
		d.Source, d.ProviderCode = "upstream_response", failure.ProviderCode
		if len(d.Requests) > 0 {
			last := d.Requests[len(d.Requests)-1]
			d.RequestID, d.HTTPStatus = firstNonEmpty(d.RequestID, last.RequestID), last.HTTPStatus
		}
	case errors.As(err, &payload):
		d.Source, d.ProviderCode = "upstream_response", failure.ProviderCode
		if failure.Category == CategoryInputInaccessible {
			d.Stage = "上游读取参考素材"
		} else if task.ProviderRequestID != "" {
			d.Stage = "上游任务处理"
		}
		if len(d.Requests) > 0 {
			last := d.Requests[len(d.Requests)-1]
			d.RequestID, d.HTTPStatus = firstNonEmpty(d.RequestID, last.RequestID), last.HTTPStatus
		}
	case errors.As(err, &appErr) && appErr.Status == 400 && source != "local_result":
		d.Source, d.Summary = "local_validation", appErr.Message
	}
	task.FailureDiagnostics = SanitizeTaskDiagnostics(d)
}
