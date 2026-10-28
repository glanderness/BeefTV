package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/generation"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/provider/workflow"
	"infinite-canvas/backend/internal/repository"
)

const providerTaskRecoveryLeaseDuration = 10 * time.Minute

type ProviderTaskQueryResult struct {
	Task           *model.Task `json:"task"`
	ProviderStatus string      `json:"providerStatus"`
	Recovered      bool        `json:"recovered"`
}

func (s *Service) QueryFailedVideoTask(ctx context.Context, userID string, taskID string) (*ProviderTaskQueryResult, error) {
	task, err := s.repo.TaskForUser(strings.TrimSpace(userID), strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	return s.queryFailedVideoTask(ctx, task, strings.TrimSpace(userID))
}

func (s *Service) AdminQueryFailedVideoTask(ctx context.Context, actor *model.User, logID string) (*ProviderTaskQueryResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	log, err := s.repo.APICallLog(strings.TrimSpace(logID))
	if err != nil {
		return nil, err
	}
	if log.Capability != "video" || strings.TrimSpace(log.TaskID) == "" {
		return nil, BadAuthRequest("该请求没有可查询的视频任务")
	}
	task, err := s.repo.Task(log.TaskID)
	if err != nil {
		return nil, err
	}
	if task.UserID != log.UserID {
		return nil, BadAuthRequest("请求与任务归属不一致")
	}
	if task.ProviderRequestID == "" {
		task.ProviderRequestID = strings.TrimSpace(log.ProviderRequestID)
	}
	result, err := s.queryFailedVideoTask(ctx, task, "")
	if err != nil {
		return nil, err
	}
	if err := s.appendAdminAudit(actor, "api_log.query_provider_task", "task", task.ID, "人工查询失败视频任务", map[string]any{
		"apiCallLogId": log.ID, "providerRequestId": task.ProviderRequestID, "providerStatus": result.ProviderStatus, "recovered": result.Recovered,
	}); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) queryFailedVideoTask(ctx context.Context, task *model.Task, claimUserID string) (*ProviderTaskQueryResult, error) {
	return s.recoverProviderTask(ctx, task, claimUserID, false)
}

func (s *Service) recoverProviderTask(ctx context.Context, task *model.Task, claimUserID string, automatic bool) (*ProviderTaskQueryResult, error) {
	ctx = withProtocolRegistry(ctx, s.protocolRegistry())
	if task == nil || task.ID == "" {
		return nil, BadAuthRequest("任务不存在")
	}
	if task.Status != model.TaskStatusFailed {
		return nil, BadAuthRequest("只能人工查询状态为失败的任务")
	}
	upscale := generation.UpscaleMediaType(task.Model) != ""
	if !strings.HasPrefix(task.Type, "canvas_video") && !strings.HasPrefix(task.Type, "video_") && !upscale {
		return nil, BadAuthRequest("该任务不是视频生成任务")
	}

	expected := *task
	s.hydrateTaskProviderRequestID(task)
	providerRequestID := strings.TrimSpace(task.ProviderRequestID)
	if providerRequestID == "" {
		return nil, BadAuthRequest("该任务没有可恢复的上游任务 ID")
	}
	decryptedInput, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, fmt.Errorf("读取任务配置失败：%w", err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(decryptedInput), &input); err != nil {
		return nil, fmt.Errorf("任务输入解析失败：%w", err)
	}
	config, err := s.resolveProviderConfig(input.Config)
	if err != nil {
		return nil, err
	}
	ctx = ensureOfficialProtocolAdapter(ctx, config.InterfaceType)
	adapter, declarative := declarativeProtocolAdapterForContext(ctx, config.InterfaceType)
	beefVideo := isBeefAPIVideoConfig(ctx, config)
	workflowVideo := workflow.IsProviderInterface(config.InterfaceType)
	_, officialVideo := generation.OfficialDeclarativeVideoInterface(config.InterfaceType)
	if officialVideo && !declarative && strings.TrimSpace(config.InterfaceType) == string(model.ChannelInterfaceGeminiVeo) {
		if candidate, ok := protocol.Builtins().Resolve(strings.TrimSpace(config.InterfaceType)); ok {
			// The shipped host adapter is a query-only compatibility fallback for
			// old Gemini tasks when the declarative package is not present in this
			// runtime. Recovery still calls BuildPoll only; it never authorizes
			// BuildCreate.
			adapter, declarative = withQueryOnlyProtocolFallback(config.InterfaceType, candidate), true
		}
	}
	legacyVideo := !officialVideo && (strings.TrimSpace(config.InterfaceType) == "" || isArkPlanVideoConfig(config))
	if !declarative && !beefVideo && !workflowVideo && !legacyVideo && !upscale {
		return nil, BadAuthRequest("该任务的请求协议不支持安全查询上游状态")
	}
	input.Config = config
	task.ProviderRequestID = providerRequestID

	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, claimUserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		if errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			return nil, &AuthError{Status: 409, Message: "该任务正在查询上游状态，请稍后再试"}
		}
		return nil, err
	}
	task.LeaseOwner = owner
	defer func() {
		if releaseErr := s.repo.ReleaseTaskProviderRecovery(task.ID, owner); releaseErr != nil {
			_ = s.log(task.UserID, task.ID, "error", "人工查询租约释放失败", releaseErr.Error())
		}
	}()
	current, err := s.repo.TaskForUser(task.UserID, task.ID)
	if err != nil {
		return nil, err
	}
	if current.RouteRun != expected.RouteRun || current.RouteID != expected.RouteID || current.ChannelModelID != expected.ChannelModelID || current.InputJSON != expected.InputJSON || current.ProviderRequestID != expected.ProviderRequestID {
		return nil, repository.ErrTaskStateConflict
	}
	if expected.ProviderRequestID == "" {
		if err := s.repo.UpdateTaskProviderState(task.ID, providerRequestID, task.PollStage, task.NextPollAt); err != nil {
			return nil, err
		}
	}

	// 上游已成功后的完整媒体下载和本地入库可能持续数十秒。浏览器关闭抽屉、
	// 页面刷新或代理断开都不应中断这项运维恢复，否则任务会再次停在
	// failed/refunded。保留请求值用于审计，但把执行生命周期交给恢复租约控制。
	recoveryCtx, cancelRecovery := context.WithTimeout(ctx, providerTaskRecoveryLeaseDuration)
	if !automatic {
		cancelRecovery()
		recoveryCtx, cancelRecovery = providerTaskRecoveryContext(ctx)
	}
	defer cancelRecovery()
	queryCtx := withProviderAnalytics(recoveryCtx, s, *task)
	var result map[string]interface{}
	var providerStatus string
	if upscale {
		result, providerStatus, err = generation.RecoverUpscaleResult(queryCtx, input, providerRequestID)
	} else if beefVideo {
		started := time.Now()
		result, providerStatus, err = queryBeefAPIVideoResultWithObservation(queryCtx, input, providerRequestID, func(state map[string]any) error {
			return s.observeTaskBilling(*task, config, providerRequestID, state, started)
		}, task.RecoveryOutcome != nil && *task.RecoveryOutcome != "")
	} else if workflowVideo {
		result, providerStatus, err = s.workflowClient(nil).QueryVideo(queryCtx, workflowConfigFromProvider(config), workflow.RootURL(config.BaseURL), providerRequestID)
	} else if !declarative && legacyVideo {
		result, providerStatus, err = generation.QueryHandwrittenVideoTask(queryCtx, input, providerRequestID)
	} else {
		result, providerStatus, err = queryProtocolAdapterVideoTask(queryCtx, input, adapter, providerRequestID)
	}
	if result == nil {
		conclusion := task.RecoveryOutcome
		var terminal originalResultConclusion
		if errors.As(err, &terminal) {
			conclusion = &terminal.outcome
		} else {
			switch strings.ToLower(providerStatus) {
			case "failed", "failure", "cancelled", "canceled":
				value := "no_result"
				conclusion = &value
			case "expired":
				value := "unrecoverable"
				conclusion = &value
			}
		}
		next := time.Now().Add(30 * time.Second)
		if finishErr := s.repo.FinishFailedResultRecovery(*task, conclusion, &next); finishErr != nil {
			return nil, finishErr
		}
	}
	if err != nil {
		_ = s.log(task.UserID, task.ID, "error", "人工查询上游视频任务失败", err.Error())
		return nil, err
	}
	if result == nil {
		_ = s.log(task.UserID, task.ID, "info", "人工查询完成，上游任务仍在处理", providerStatus)
		return &ProviderTaskQueryResult{Task: taskForOutput(*task), ProviderStatus: providerStatus, Recovered: false}, nil
	}

	result, err = s.persistTaskGeneratedMediaResult(*task, result)
	if err != nil {
		_ = s.log(task.UserID, task.ID, "error", "人工查询已取得视频，但结果保存失败", err.Error())
		return nil, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	task.Error = ""
	task.PollStage = strings.ToLower(providerStatus)
	task.NextPollAt = nil
	if err := s.saveTaskCompletionWithinStorageQuota(task, resultJSON, nil, false); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "人工查询已取得视频，但任务恢复失败", err.Error())
		return nil, err
	}
	if err := s.RegisterTaskOutputFromTask(*task); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "任务恢复成功但项目产物登记失败", err.Error())
		return nil, fmt.Errorf("任务已恢复，但项目素材登记失败：%w", err)
	}
	projected := s.attachRecoveredProviderTask(task)
	_ = s.log(task.UserID, task.ID, "info", "人工查询确认生成成功，任务已恢复并登记项目产物", providerStatus)
	return &ProviderTaskQueryResult{Task: projected, ProviderStatus: providerStatus, Recovered: true}, nil
}

// Query-only: never route recovery through create, even when the original
// persisted channel metadata names the legacy generations protocol.
func queryBeefAPIVideoResult(ctx context.Context, input canvasGenerationInput, id string) (map[string]interface{}, string, error) {
	return queryBeefAPIVideoResultWithObservation(ctx, input, id, nil, false)
}

func queryBeefAPIVideoResultWithObservation(ctx context.Context, input canvasGenerationInput, id string, observe func(map[string]any) error, billingOnly bool) (map[string]interface{}, string, error) {
	var state map[string]interface{}
	if err := getJSON(withProviderRequestKind(ctx, "poll"), input.Config, "/video/generations/"+url.PathEscape(id), &state); err != nil {
		return nil, "", err
	}
	if data, ok := state["data"].(map[string]any); ok && state["code"] == "success" {
		if _, ok := data["task_id"]; ok {
			// TaskDto.id is a numeric database row, not the provider task ID;
			// TaskDto.data is provider payload, not another task envelope.
			state = data
			delete(state, "data")
			if _, ok := state["id"].(float64); ok {
				delete(state, "id")
			}
		}
	}
	var err error
	state, err = generation.ValidateVideoTaskState(id, state)
	if err != nil {
		return nil, "", err
	}
	if observe != nil {
		if err := observe(state); err != nil {
			return nil, "", err
		}
	}
	status, videoURL := seedancePollStatusAndURL(state)
	if billingOnly {
		return nil, status, nil
	}
	if status == "failed" || status == "cancelled" || status == "expired" {
		outcome := "no_result"
		if status == "expired" {
			outcome = "unrecoverable"
		}
		return nil, status, originalResultConclusion{outcome}
	}
	if !generation.VideoTaskSucceeded(status) {
		return nil, status, nil
	}
	if videoURL == "" {
		videoURL = generation.APIURL(input.Config.BaseURL, "/videos/"+id+"/content")
	}
	data, mimeType, err := generation.DownloadVideoResult(ctx, input.Config, videoURL, id)
	if err != nil {
		return nil, status, err
	}
	return map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}, status, nil
}

type queryOnlyProtocolAdapter struct {
	protocol.Adapter
}

func withQueryOnlyProtocolFallback(interfaceType string, adapter protocol.Adapter) protocol.Adapter {
	if strings.TrimSpace(interfaceType) != string(model.ChannelInterfaceGeminiVeo) {
		return adapter
	}
	return queryOnlyProtocolAdapter{Adapter: adapter}
}

func (a queryOnlyProtocolAdapter) BuildPoll(_ context.Context, c protocol.PollContext) (protocol.RequestSpec, error) {
	return protocol.RequestSpec{
		Method: http.MethodGet,
		Path:   "/v1beta/" + strings.TrimPrefix(strings.TrimSpace(c.TaskID), "/"),
		Auth:   a.MediaAuth(),
	}, nil
}

func (queryOnlyProtocolAdapter) MediaAuth() protocol.ManifestAuth {
	return protocol.ManifestAuth{Type: "google-api-key", Field: "apiKey", Header: "x-goog-api-key"}
}

func providerTaskRecoveryContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), providerTaskRecoveryLeaseDuration)
}
