package generation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beefapi"
)

// Managed connections expose content intent, never a supplier request body.
// Model discovery/validation is server-owned; BYOK still uses its own plugin.
func managedConnection(config Config) bool { return config.CredentialRef == beefapi.CredentialRef }

func legacyMediaError(err error) error {
	var upstream *beefapi.MediaHTTPError
	if errors.As(err, &upstream) {
		body, _ := json.Marshal(map[string]any{"error": upstream.TaskError})
		if upstream.Body != "" {
			body = []byte(upstream.Body)
		}
		return HTTPError{StatusCode: upstream.StatusCode, Body: string(body), RequestID: upstream.RequestID}
	}
	return err
}

func referenceMediaUploadError(ctx context.Context, err error) *ReferenceUploadError {
	var upload *beefapi.UploadError
	if errors.As(err, &upload) {
		ctx = referenceUploadAttempt(referenceUploadStage(ctx, upload.Meta.Stage), upload.Meta.Attempt)
	}
	result := referenceUploadError(ctx, legacyMediaError(err))
	if upload != nil {
		result.Dispatched, result.TransportPhase = upload.Dispatched, upload.Phase
	}
	return result
}

func runManagedImageTask(ctx context.Context, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	client := managedMediaClient(ctx, input.Config)
	if runtime.ManagedMedia == nil || SubmissionKeyFromContext(ctx) == "" {
		return nil, RequestPreparationError{Cause: errors.New("图片请求缺少持久化提交标识")}
	}
	request := beefapi.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "image", Model: input.Config.Model, Operation: "generate", Options: managedImageOptions(input)}
	request.Input.Prompt = WithSystemPrompt(input.Config, input.Prompt)
	refs := make([]beefapi.LocalMediaReference, 0, len(input.ReferenceImages)+1)
	for _, image := range input.ReferenceImages {
		refs = append(refs, managedReference(image, "reference"))
	}
	if input.Mask != nil {
		refs = append(refs, managedReference(*input.Mask, "mask"))
	}
	if input.ImageCapability != nil {
		for i := range refs {
			refs[i].MaxBytes = input.ImageCapability.References.MaxImageBytes
		}
	}
	if len(refs) > 0 {
		request.Operation = "edit"
	}
	result, err := client.Execute(ctx, request, refs)
	if err != nil {
		var terminal *beefapi.MediaTaskError
		if errors.As(err, &terminal) {
			return nil, err
		}
		if sent, lookupErr := runtime.ManagedMedia.Sent(ctx); lookupErr == nil && sent {
			return nil, SubmissionUnknownError{Cause: err}
		}
		return nil, RequestPreparationError{Cause: err}
	}
	return result, nil
}
func managedReference(media Media, role string) beefapi.LocalMediaReference {
	return beefapi.LocalMediaReference{MediaReference: beefapi.MediaReference{Kind: "image", Role: role, URL: media.URL}, StorageKey: media.StorageKey, DataURL: media.DataURL, MIME: media.MimeType, Bytes: media.Bytes}
}

func validateManagedImageReference(input *Input, size int64) error {
	if size <= 0 {
		return errors.New("参考素材为空")
	}
	if input.ImageCapability != nil && input.ImageCapability.References.MaxImageBytes > 0 && size > input.ImageCapability.References.MaxImageBytes {
		return errors.New("参考图片文件超过当前模型大小限制")
	}
	return nil
}
func managedImageOptions(input Input) map[string]any {
	config := input.Config
	options := map[string]any{}
	if config.Size != "" {
		options["size"] = config.Size
	}
	if config.Quality != "" {
		options["quality"] = config.Quality
	}
	if n, err := strconv.Atoi(config.Count); err == nil && n > 0 {
		options["n"] = n
	}
	if config.TransparentBackground == "true" {
		options["background"] = "transparent"
		options["output_format"] = "png"
	}
	if config.SeedreamOutputFormat != "" {
		options["output_format"] = config.SeedreamOutputFormat
	}
	if config.TransparentBackground == "true" {
		options["output_format"] = "png"
	}
	if config.SeedreamMode == "layers" {
		options["layer_decomposition"] = true
	}
	if n, err := strconv.Atoi(config.SeedreamMaxImages); err == nil && n > 1 {
		options["sequential_image_generation"] = "auto"
		options["sequential_image_generation_options"] = map[string]any{"max_images": n}
	}
	if config.SeedreamOptimize != "" {
		options["optimize_prompt_options"] = map[string]any{"mode": config.SeedreamOptimize}
	}
	if config.SeedreamWatermark != "" {
		options["watermark"] = config.SeedreamWatermark == "true"
	}
	return options
}
func managedMediaClient(ctx context.Context, config Config) *beefapi.MediaClient {
	runtime, _ := RuntimeFromContext(ctx)
	client := &beefapi.MediaClient{BaseURL: config.BaseURL, APIKey: config.APIKey, State: runtime.ManagedMedia, AllowHTTPTest: runtime.Endpoints.BeefAPIVideoBaseURL != ""}
	client.Headers = make(http.Header)
	if projection, ok := runtime.ManagedMedia.(beefapi.MediaProjectionPort); ok {
		client.Project = projection.Project
	}
	for _, header := range config.Headers {
		client.Headers.Set(header.Name, header.Value)
	}
	client.Open = func(_ context.Context, key string) (io.ReadCloser, string, int64, error) {
		if runtime.Resources == nil || !strings.HasPrefix(key, "resource:") {
			return nil, "", 0, errors.New("参考素材资源端口未接入")
		}
		info, body, err := runtime.Resources.Open(runtime.Call.UserID, strings.TrimPrefix(key, "resource:"))
		return body, info.MimeType, info.Size, err
	}
	observers := map[string]func(int64, int64, string){}
	client.Progress = func(label string, loaded, total int64, phase string) {
		if runtime.ReferenceProgress == nil {
			return
		}
		if reporter, _ := ctx.Value(referenceProgressContext{}).(*referenceReporter); reporter != nil {
			if phase == "resuming" {
				reporter.resumeAt(loaded)
			} else {
				reporter.report(phase, loaded)
			}
			return
		}
		// Reuse the task-bound progress port; no upload journal is introduced.
		observer := observers[label]
		if observer == nil {
			observer = ReferenceUploadObserver(ctx, label)
			observers[label] = observer
		}
		observer(loaded, total, phase)
	}
	client.Observe = func(req *http.Request, resp *http.Response, body []byte, err error) {
		if runtime.Receipts == nil {
			return
		}
		if meta := beefapi.UploadMetaFromContext(req.Context()); meta.Stage != "" {
			req = req.WithContext(referenceUploadAttempt(referenceUploadStage(req.Context(), meta.Stage), meta.Attempt))
		}
		observation := TransportObservation{Request: req, Body: body, Err: legacyMediaError(err), StartedAt: time.Now(), Dispatched: true, ResponseLimitBytes: 4 << 20, ReceivedBytes: int64(len(body))}
		if resp != nil {
			observation.StatusCode = resp.StatusCode
			observation.HTTPStatus = resp.StatusCode
			observation.DeclaredResponseBytes = resp.ContentLength
			observation.Headers = resp.Header.Clone()
		}
		runtime.Receipts.Observe(observation)
	}
	client.StorageObserve = func(observation beefapi.UploadObservation) {
		if runtime.Receipts == nil {
			return
		}
		req := observation.Request.WithContext(referenceUploadStage(observation.Request.Context(), "put"))
		value := TransportObservation{Request: req, StartedAt: observation.StartedAt, Err: observation.Err, Dispatched: observation.Dispatched, TransportPhase: observation.Phase, TransportRoute: observation.Route, ReceivedBytes: observation.ReceivedBytes, ResponseLimitBytes: 1 << 20}
		if meta := beefapi.UploadMetaFromContext(req.Context()); meta.Attempt > 0 {
			value.Request = value.Request.WithContext(referenceUploadAttempt(value.Request.Context(), meta.Attempt))
		}
		if observation.Response != nil {
			value.StatusCode = observation.Response.StatusCode
			value.HTTPStatus = value.StatusCode
			value.Headers = observation.Response.Header.Clone()
			value.DeclaredResponseBytes = observation.Response.ContentLength
		}
		runtime.Receipts.Observe(value)
	}
	return client
}
