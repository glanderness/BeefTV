package app

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/provider/workflow"
)

// WorkflowField 是云端工作流字段描述。实现位于 provider/workflow。
type WorkflowField = workflow.Field

// RunningHubWorkflowFetchRequest 只用于独立工作流设置页，不进入 ModelChannel。
type RunningHubWorkflowFetchRequest = workflow.FetchRequest

func isRunningHubInterface(value string) bool {
	pluginID, ok := workflowPluginIDForInterface(normalizeWorkflowInterfaceType(value))
	return ok && pluginID == WorkflowPluginRunningHub
}

func isWorkflowProviderInterface(value string) bool {
	return isRunningHubInterface(value)
}

func validateWorkflowProviderConfig(mode string, config providerConfig) error {
	return mapOutboundError(workflow.ValidateConfig(mode, workflowConfigFromProvider(config)))
}

func (s *Service) runWorkflowProviderTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	if isRunningHubInterface(input.Config.InterfaceType) {
		return s.runRunningHubWorkflow(ctx, input)
	}
	return nil, errors.New("未知工作流协议")
}

func (s *Service) updateWorkflowProviderState(ctx context.Context, requestID string, stage string, nextPollAt *time.Time) error {
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.TaskID == "" {
		return nil
	}
	return s.repo.UpdateTaskProviderState(metadata.TaskID, requestID, stage, nextPollAt)
}

func (s *Service) recordWorkflowProviderRequest(ctx context.Context, requestID string, stage string, nextPollAt *time.Time) error {
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.TaskID == "" {
		return nil
	}
	return s.repo.UpdateTaskProviderState(metadata.TaskID, requestID, stage, nextPollAt)
}

func (s *Service) runRunningHubWorkflow(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return s.workflowClient(nil).Run(ctx, s.workflowInputFromCanvas(ctx, input))
}

func (s *Service) fetchRunningHubWorkflowJSON(ctx context.Context, root string, config providerConfig, workflowID string) (map[string]interface{}, error) {
	return s.workflowClient(nil).FetchWorkflowJSON(ctx, root, workflowConfigFromProvider(config), workflowID)
}

func (s *Service) uploadRunningHubMedia(ctx context.Context, root string, config providerConfig, media providerMedia) (string, error) {
	return s.workflowClient(nil).UploadMedia(ctx, root, workflowConfigFromProvider(config), workflowMedia(media), s.IsLocalMode())
}

func (s *Service) runningHubJSON(ctx context.Context, config providerConfig, endpoint string, body interface{}, target *map[string]any) error {
	result, err := s.workflowClient(nil).PostJSON(ctx, workflowConfigFromProvider(config), endpoint, "", body)
	if err != nil {
		return err
	}
	if target != nil {
		*target = result
	}
	return nil
}

func (s *Service) pollRunningHubWorkflow(ctx context.Context, config providerConfig, root string, taskID string, mode string) (map[string]interface{}, error) {
	return s.workflowClient(nil).Poll(ctx, workflowConfigFromProvider(config), root, taskID, mode)
}

func (s *Service) pollRunningHubVideoWorkflowWithPolicy(ctx context.Context, config providerConfig, root string, taskID string, policy videoPollPolicy) (map[string]interface{}, error) {
	return s.workflowClient(&policy).PollVideo(ctx, workflowConfigFromProvider(config), root, taskID, toWorkflowPollPolicy(policy))
}

func (s *Service) pollRunningHubWorkflowLegacy(ctx context.Context, config providerConfig, root string, taskID string) (map[string]interface{}, error) {
	return s.workflowClient(nil).Poll(ctx, workflowConfigFromProvider(config), root, taskID, "image")
}

func (s *Service) downloadWorkflowOutputs(ctx context.Context, urls []string) (map[string]interface{}, error) {
	return s.workflowClient(nil).DownloadOutputs(ctx, urls, "", nil)
}

func (s *Service) downloadWorkflowVideoOutputs(ctx context.Context, urls []string, taskID string, policy videoPollPolicy) (map[string]interface{}, error) {
	mapped := toWorkflowPollPolicy(policy)
	return s.workflowClient(&policy).DownloadOutputs(ctx, urls, taskID, &mapped)
}

func runningHubRootURL(value string) string { return workflow.RootURL(value) }

func runningHubAPIKey(config providerConfig) string {
	return workflow.APIKey(workflowConfigFromProvider(config))
}

func runningHubPayloadCode(payload map[string]any) (int, bool) { return workflow.PayloadCode(payload) }

func runningHubFailureMessage(payload map[string]any) string {
	return workflow.FailureMessage(payload)
}
