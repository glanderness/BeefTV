package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) taskDomain() *localtask.Service {
	if s.tasks != nil {
		return s.tasks
	}
	s.tasksOnce.Do(func() {
		if s.tasks == nil {
			s.tasks = localtask.NewService(localtask.NewStore(s.repo), s.taskDependencies())
		}
	})
	return s.tasks
}

// TaskService exposes the same domain owner used by internal orchestration.
func (s *Service) TaskService() *localtask.Service { return s.taskDomain() }

func (s *Service) taskDependencies() localtask.Dependencies {
	return localtask.Dependencies{
		Catalog:    taskCatalogAdapter{s},
		Secrets:    taskSecretsAdapter{s},
		Media:      taskMediaAdapter{},
		Projects:   taskProjectsAdapter{s},
		Policy:     taskPolicyAdapter{s},
		Persist:    taskPersistAdapter{s},
		Runtime:    taskRuntimeAdapter{s},
		Images:     taskImagesAdapter{s},
		Failures:   taskFailuresAdapter{},
		TextReplay: taskTextReplayAdapter{s},
		Provider:   taskProviderAdapter{s},
		Present:    taskPresenterAdapter{s},
		Logs:       taskLogAdapter{s},
		Activity:   taskActivityAdapter{s},
		NewID:      newID,
	}
}

func toTaskCreateRequest(req CreateTaskRequest) localtask.CreateRequest {
	out := localtask.CreateRequest{
		ProjectID:      req.ProjectID,
		Type:           req.Type,
		Operation:      req.Operation,
		Prompt:         req.Prompt,
		Provider:       req.Provider,
		Model:          req.Model,
		LogicalModelID: req.LogicalModelID,
		Input:          req.Input,
		TraceID:        req.TraceID,
		RequestID:      req.RequestID,
		PrepareOnly:    req.creationPrepare != nil,
	}
	if req.admission != nil {
		out.AdmissionID = req.admission.ID
	}
	return out
}

type taskCatalogAdapter struct{ s *Service }

func (a taskCatalogAdapter) Select(userID string, req localtask.SelectRequest) (localtask.SelectResult, error) {
	input := req.Input
	if taskInputUsesWorkflowProvider(input) {
		config, _ := input["config"].(map[string]any)
		if err := a.s.RequireWorkflowPluginForUser(userID, strings.TrimSpace(fmt.Sprint(config["interfaceType"]))); err != nil {
			return localtask.SelectResult{}, err
		}
		return localtask.SelectResult{Input: input, Workflow: true}, nil
	}
	frontendEnabled, err := a.s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return localtask.SelectResult{}, err
	}
	routed, normalized, err := a.s.resolveTaskModelSelection(input, req.LogicalModelID, req.Type, req.Operation, frontendEnabled)
	if err != nil {
		return localtask.SelectResult{}, err
	}
	result := localtask.SelectResult{Input: normalized}
	if routed != nil {
		result.Binding = &localtask.RouteBinding{
			LogicalModelID:         routed.LogicalModel.ID,
			LogicalModelRevisionID: routed.Revision.ID,
			RouteID:                routed.Route.ID,
			ChannelModelID:         routed.ChannelModel.ID,
			Model:                  routed.LogicalModel.Code,
			Provider:               "managed",
		}
	}
	return result, nil
}

func (a taskCatalogAdapter) PrepareRetry(task *model.Task, input map[string]any) error {
	return a.s.prepareLogicalTaskRetry(task, input)
}

func (a taskCatalogAdapter) RequireCustomChannels(input map[string]any) error {
	return a.s.requireCustomChannelsForTaskInput(input)
}

func (a taskCatalogAdapter) ValidateCapability(input map[string]any) error {
	return a.s.ValidateTaskCapability(input)
}

func (taskCatalogAdapter) HasExecutableVideoConfig(input map[string]any) bool {
	return hasExecutableProviderVideoConfig(input)
}

type taskSecretsAdapter struct{ s *Service }

func (a taskSecretsAdapter) ResolveManaged(input map[string]any) (map[string]any, error) {
	return a.s.resolveManagedBeefAPISecrets(input)
}

func (a taskSecretsAdapter) Protect(input map[string]any) error {
	return a.s.protectTaskSecrets(input)
}

func (a taskSecretsAdapter) DecryptInputJSON(raw string) (string, error) {
	return a.s.decryptTaskInputJSON(raw)
}

type taskMediaAdapter struct{}

func (taskMediaAdapter) ContainsInlineData(input map[string]any) bool {
	return containsInlineMediaDataURL(input)
}

type taskProjectsAdapter struct{ s *Service }

func (a taskProjectsAdapter) EnsureActive(userID, canvasOrProjectID string) error {
	return a.s.ensureTaskProjectActive(userID, canvasOrProjectID)
}

type taskPolicyAdapter struct{ s *Service }

func (a taskPolicyAdapter) ActiveTaskLimit() (int, error) {
	policy, err := a.s.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return policy.Task.ActiveTaskLimit, nil
}

type taskPersistAdapter struct{ s *Service }

func (a taskPersistAdapter) CreateAdmitted(task *model.Task, limit int) error {
	policy, err := a.s.RuntimePolicy()
	if err != nil {
		return err
	}
	policy.Task.ActiveTaskLimit = limit
	return a.s.createTaskWithinStorageQuota(task, policy)
}

type taskRuntimeAdapter struct{ s *Service }

func (a taskRuntimeAdapter) IsDraining() bool { return a.s.IsDraining() }

func (a taskRuntimeAdapter) StopLocalWait(taskID string) { a.s.cancelActiveTask(taskID) }

func (a taskRuntimeAdapter) Dispatch(fn func()) bool { return a.s.runWorkerTask(fn) }

type taskImagesAdapter struct{ s *Service }

func (a taskImagesAdapter) ValidateRetry(task *model.Task) error {
	return a.s.validateImageTaskRetry(task)
}

type taskFailuresAdapter struct{}

func (taskFailuresAdapter) BlocksRetry(message, stage string) bool {
	return persistedFailureBlocksRetry(message, stage)
}

func (taskFailuresAdapter) IsModeration(message string) bool {
	return isContentModerationFailure(message)
}

func (taskFailuresAdapter) Category(message, stage string) generation.FailureCategory {
	if stage == "submission_unknown" {
		return generation.CategorySubmissionUncertain
	}
	return classifyTaskFailure(errors.New(message)).Category
}

func (taskFailuresAdapter) UserMessage(message string) string {
	return classifyTaskFailure(errors.New(message)).UserMessage()
}

type taskTextReplayAdapter struct{ s *Service }

func (taskTextReplayAdapter) IsRequest(input map[string]any) bool {
	return isTextReplayTaskRequest(input)
}

func (a taskTextReplayAdapter) Finalize(taskID string, status model.TaskStatus) error {
	return a.s.finalizeTaskTextReplay(taskID, status)
}

type taskProviderAdapter struct{ s *Service }

func (a taskProviderAdapter) RequestCancel(ctx context.Context, task *model.Task) error {
	return a.s.requestProviderCancellation(ctx, task)
}

type taskPresenterAdapter struct{ s *Service }

func (a taskPresenterAdapter) Task(task model.Task) *model.Task {
	if err := a.s.ensureSucceededTaskDelivery(&task); err != nil {
		_ = a.s.log(task.UserID, task.ID, "error", "读取任务时补齐结果交付失败", err.Error())
	}
	projected := taskForOutput(task)
	a.s.attachTaskDelivery(projected)
	return projected
}

func (a taskPresenterAdapter) Summaries(tasks []model.Task) []localtask.Summary {
	summaries := taskSummariesForOutput(tasks)
	a.s.attachTaskSummaryDeliveries(tasks, summaries)
	return summaries
}

func (taskPresenterAdapter) Logs(logs []model.TaskLog) []model.TaskLog {
	for i := range logs {
		logs[i].Summary = generation.DiagnosticSummary(logs[i].Message)
		if logs[i].Level == "error" && logs[i].Payload != "" {
			logs[i].Summary += "：" + generation.ClassifyText(logs[i].Payload).UserMessage()
		}
		logs[i].Message, logs[i].Payload = "", ""
	}
	return logs
}

type taskLogAdapter struct{ s *Service }

func (a taskLogAdapter) Log(userID, taskID, level, message, payload string) error {
	return a.s.log(userID, taskID, level, message, payload)
}

type taskActivityAdapter struct{ s *Service }

func (a taskActivityAdapter) Record(userID, kind string, n int) {
	a.s.recordActivity(userID, kind, n)
}

func isRetiredAgentOperation(operation string) bool {
	return localtask.IsRetiredAgentOperation(operation)
}

func isRetiredAgentTaskInput(operation string, input map[string]any) bool {
	return localtask.IsRetiredAgentTaskInput(operation, input)
}

func retiredAgentTask(task *model.Task) bool {
	return localtask.RetiredAgentTask(task)
}

func clientOperationHash(req CreateTaskRequest) (string, error) {
	return localtask.ClientOperationHash(toTaskCreateRequest(req))
}

func clientOperationID(input map[string]any) (string, error) {
	return localtask.ClientOperationID(input)
}

func normalizeTaskInput(input map[string]any) (map[string]any, error) {
	return localtask.NormalizeInput(input)
}

func validateTaskType(taskType string) error {
	return localtask.ValidateType(taskType)
}

func (s *Service) validateRetryTaskType(userID string, taskType string, input map[string]any) error {
	return s.taskDomain().ValidateRetryType(userID, taskType, input)
}
