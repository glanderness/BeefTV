package app

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

type appResourcePort struct{ service *Service }

func (p appResourcePort) Lookup(userID, resourceID string) (generation.ResourceInfo, error) {
	resource, err := p.service.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	return resourceInfoFromModel(userID, resource), nil
}

func (p appResourcePort) Open(userID, resourceID string) (generation.ResourceInfo, io.ReadCloser, error) {
	resource, body, err := p.service.OpenResource(userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, nil, err
	}
	return resourceInfoFromModel(userID, resource), body, nil
}

func (p appResourcePort) PublicURL(info generation.ResourceInfo, expiresAt time.Time) (string, error) {
	resource, err := p.service.repo.ResourceForUser(info.UserID, info.ID)
	if err != nil {
		return "", err
	}
	return p.service.directResourceURL(resource, expiresAt)
}

func (p appResourcePort) HTTPSPublicURL(info generation.ResourceInfo, expiresAt time.Time) (string, error) {
	resource, err := p.service.repo.ResourceForUser(info.UserID, info.ID)
	if err != nil {
		return "", err
	}
	return p.service.signedHTTPSPublicResourceURL(resource, expiresAt)
}

func (p appResourcePort) LocalMode() bool {
	return p.service != nil && p.service.IsLocalMode()
}

type appLimitsPort struct{ service *Service }

func (p appLimitsPort) GeneratedFileBytes(ctx context.Context) (int64, error) {
	policy, err := p.service.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.GeneratedFileMB), nil
}

func (p appLimitsPort) ResourceUploadBytes(ctx context.Context) (int64, error) {
	policy, err := p.service.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.ResourceUploadMB), nil
}

func (p appLimitsPort) CircuitOpen(ctx context.Context, channelID string) (bool, error) {
	if p.service == nil || p.service.coordinator == nil {
		return false, nil
	}
	return p.service.coordinator.CircuitOpen(ctx, channelID)
}

func (p appLimitsPort) AcquireChannelSlot(ctx context.Context, channelID, slotID string, timeout time.Duration) (func(), int, error) {
	return p.service.AcquireChannelSlot(ctx, channelID, slotID, timeout)
}

func (p appLimitsPort) RecordChannelResult(ctx context.Context, channelID string, failure bool) error {
	return p.service.RecordChannelResult(ctx, channelID, failure)
}

type appReceiptPort struct{ service *Service }

func (p appReceiptPort) Observe(observation generation.TransportObservation) {
	if observation.Request == nil {
		return
	}
	evidence := model.TaskRequestEvidence{
		StartedAt:             observation.StartedAt.Format(time.RFC3339Nano),
		ResponseLimitBytes:    observation.ResponseLimitBytes,
		Dispatched:            observation.Dispatched,
		HTTPStatus:            observation.HTTPStatus,
		DeclaredResponseBytes: observation.DeclaredResponseBytes,
		ReceivedBytes:         observation.ReceivedBytes,
		RequestID:             observation.RequestID,
		Outcome:               observation.Outcome,
	}
	recordTaskRequestEvidence(observation.Request, evidence, observation.Body, observation.Err)
	recordProviderRequest(observation.Request, observation.StartedAt, observation.StatusCode, observation.Body, observation.Err)
}

func (p appReceiptPort) NotifyPoll(ctx context.Context, event string, err error) {
	if p.service == nil || p.service.repo == nil {
		return
	}
	call := canonicalCallMeta(ctx)
	if strings.TrimSpace(call.TaskID) == "" {
		return
	}
	message := "上游视频查询暂时异常，将继续轮询原任务"
	level := "warn"
	payload := ""
	if err != nil {
		payload = err.Error()
	}
	if videoPollEvent(event) == videoPollEventRecovered {
		message = "上游视频查询已恢复"
		level = "info"
	}
	_ = p.service.log(call.UserID, call.TaskID, level, message, payload)
}

func (p appReceiptPort) SyncProgress(taskID string, body []byte) {
	if p.service == nil {
		return
	}
	p.service.syncProviderTaskProgress(taskID, body)
}

type appImagePort struct{ service *Service }

func (p appImagePort) Intercept(req *http.Request) (bool, []byte, string, error) {
	s, row, handled, err := prepareImageSubmission(req)
	if !handled {
		return false, nil, "", nil
	}
	if err != nil {
		return true, nil, "", imageRecoveryError{err}
	}
	task := req.Context().Value(imageTaskContext{}).(model.Task)
	data, mimeType, sendErr := s.sendImageSubmission(req.Context(), task, row)
	return true, data, mimeType, sendErr
}

type appWorkflowPort struct{ service *Service }

func (p appWorkflowPort) Execute(ctx context.Context, input generation.Input) (map[string]interface{}, error) {
	return p.service.runWorkflowProviderTask(ctx, input)
}

type appMediaProbe struct{}

func (appMediaProbe) ProbeSeedance2Video(config generation.Config, index int, media *generation.Media, data []byte) error {
	return applySeedance2VideoProbe(config, index, media, data)
}

func resourceInfoFromModel(userID string, resource *model.Resource) generation.ResourceInfo {
	if resource == nil {
		return generation.ResourceInfo{UserID: userID}
	}
	return generation.ResourceInfo{
		UserID:     userID,
		ID:         resource.ID,
		Status:     string(resource.Status),
		Kind:       resource.Kind,
		MimeType:   resource.MimeType,
		Provider:   resource.Provider,
		Size:       resource.Size,
		Width:      resource.Width,
		Height:     resource.Height,
		DurationMs: resource.DurationMs,
	}
}

func (s *Service) bindGenerationRuntime(ctx context.Context, meta generation.CallMeta) context.Context {
	return s.applyGenerationRuntime(ctx, meta, true)
}

func (s *Service) enrichGenerationRuntime(ctx context.Context, meta generation.CallMeta) context.Context {
	return s.applyGenerationRuntime(ctx, meta, false)
}

func (s *Service) applyGenerationRuntime(ctx context.Context, meta generation.CallMeta, replaceCall bool) context.Context {
	if s == nil {
		if replaceCall {
			return generation.WithCallMeta(ctx, meta)
		}
		return generation.EnrichCallMeta(ctx, meta)
	}
	runtime := generation.Runtime{
		Resources: appResourcePort{service: s},
		Receipts:  appReceiptPort{service: s},
		Images:    appImagePort{service: s},
		Workflow:  appWorkflowPort{service: s},
		Probe:     appMediaProbe{},
		Call:      meta,
	}
	if s.repo != nil {
		runtime.Limits = appLimitsPort{service: s}
	}
	if existing, ok := generation.RuntimeFromContext(ctx); ok {
		runtime.Endpoints = existing.Endpoints
		if !replaceCall {
			runtime.Call = generation.IdentityCallMeta(existing.Call, meta)
		}
		if runtime.Limits == nil {
			runtime.Limits = existing.Limits
		}
	}
	return generation.WithRuntime(ctx, runtime)
}

func generationCallMeta(metadata providerAnalyticsContext) generation.CallMeta {
	return generation.CallMeta{
		UserID:            metadata.UserID,
		TaskID:            metadata.TaskID,
		TraceID:           metadata.TraceID,
		RequestID:         metadata.RequestID,
		Capability:        metadata.Capability,
		Operation:         metadata.Operation,
		ChannelID:         metadata.ChannelID,
		Model:             metadata.Model,
		VideoSeconds:      metadata.VideoSeconds,
		RequestKind:       metadata.RequestKind,
		ProviderRequestID: metadata.ProviderRequestID,
		ConcurrencyLimit:  metadata.ConcurrencyLimit,
	}
}
