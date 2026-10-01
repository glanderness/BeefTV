package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) Retry(userID, id string) (*model.Task, error) {
	if s.deps.Runtime != nil && s.deps.Runtime.IsDraining() {
		return nil, drainError(DrainRetryMessage)
	}
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	if task.CreationSubmissionID != nil {
		return nil, kernel.NewAppError(kernel.CodeConflict, CreationRetryConflictMessage)
	}
	if RetiredAgentTask(task) {
		return nil, kernel.BadAuthRequest(RetiredAgentBoundaryMessage)
	}
	if task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return nil, errors.New(RetryOnlyFailedOrCancelled)
	}
	if s.deps.Images != nil {
		if err := s.deps.Images.ValidateRetry(task); err != nil {
			return nil, err
		}
	} else if task.Type == "canvas_image" {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务服务不可用")
	}
	if task.ProviderCancelStatus == model.ProviderCancelStatusRequested {
		return nil, kernel.BadAuthRequest(CancellationPendingRetryMessage)
	}
	if s.deps.Failures != nil && s.deps.Failures.IsModeration(task.Error) {
		return nil, kernel.BadAuthRequest(ContentModerationRetryMessage)
	}
	if s.deps.Failures != nil && s.deps.Failures.BlocksRetry(task.Error, task.Stage) {
		category := s.deps.Failures.Category(task.Error, task.Stage)
		if task.Stage == "submission_unknown" || category == generation.CategorySubmissionUncertain {
			return nil, kernel.BadAuthRequest(SubmissionUncertainRetryMessage)
		}
		if category == generation.CategoryDownloadFailed {
			return nil, kernel.BadAuthRequest(DownloadFailureRetryMessage)
		}
		return nil, kernel.BadAuthRequest(s.deps.Failures.UserMessage(task.Error))
	}
	decryptedInput := task.InputJSON
	if s.deps.Secrets != nil {
		decryptedInput, err = s.deps.Secrets.DecryptInputJSON(task.InputJSON)
		if err != nil {
			return nil, err
		}
	}
	var taskInput map[string]any
	if err := json.Unmarshal([]byte(decryptedInput), &taskInput); err != nil {
		return nil, err
	}
	if s.deps.Catalog != nil {
		if err := s.deps.Catalog.PrepareRetry(task, taskInput); err != nil {
			return nil, err
		}
		if err := s.deps.Catalog.RequireCustomChannels(taskInput); err != nil {
			return nil, err
		}
	}
	if s.deps.Policy == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务服务不可用")
	}
	limit, err := s.deps.Policy.ActiveTaskLimit()
	if err != nil {
		return nil, err
	}
	if s.deps.Projects != nil {
		if err := s.deps.Projects.EnsureActive(userID, task.ProjectID); err != nil {
			return nil, err
		}
	}
	task, err = s.store.Retry(userID, task, limit)
	if errors.Is(err, repository.ErrActiveTaskLimit) {
		return nil, activeLimitError(limit)
	}
	if errors.Is(err, repository.ErrTaskNotRetryable) {
		return nil, kernel.BadAuthRequest(RetryNotRetryableMessage)
	}
	if err != nil {
		return nil, err
	}
	s.log(userID, task.ID, "info", "任务已重新入队", "")
	return presentTask(s.deps.Present, *task), nil
}

func (s *Service) Cancel(ctx context.Context, userID, id string) (*model.Task, error) {
	_ = ctx
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
		if task.Status == model.TaskStatusCancelled {
			return presentTask(s.deps.Present, *task), nil
		}
		return nil, fmt.Errorf("任务当前状态为 %s，无法取消", task.Status)
	}

	s.hydrateProviderRequestID(task)
	now := s.now()
	cancelled, err := s.store.CancelIfStatus(userID, id, task.Status, now)
	if err != nil {
		return nil, err
	}
	if !cancelled {
		latest, latestErr := s.store.TaskForUser(userID, id)
		if latestErr != nil {
			return nil, latestErr
		}
		if latest.Status == model.TaskStatusCancelled {
			return presentTask(s.deps.Present, *latest), nil
		}
		return nil, errors.New(CancelChangedMessage)
	}

	task.Status = model.TaskStatusCancelled
	task.Stage = "任务已取消"
	task.Error = "任务已取消"
	task.CompletedAt = &now
	if s.deps.Runtime != nil {
		s.deps.Runtime.StopLocalWait(task.ID)
	}

	if s.deps.TextReplay != nil {
		if err := s.deps.TextReplay.Finalize(task.ID, model.TaskStatusCancelled); err != nil {
			s.log(task.UserID, task.ID, "error", "取消任务后归并文本回放失败", err.Error())
		}
	}
	s.log(task.UserID, task.ID, "warn", "用户主动取消任务", "")

	if task.ProviderRequestID != "" && s.deps.Provider != nil {
		cancelTask := *task
		run := func() {
			requestCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := s.deps.Provider.RequestCancel(requestCtx, &cancelTask); err != nil {
				s.log(cancelTask.UserID, cancelTask.ID, "error", "发送上游取消请求失败", err.Error())
			}
		}
		started := false
		if s.deps.Runtime != nil {
			started = s.deps.Runtime.Dispatch(run)
		}
		if !started {
			run()
		}
	}

	return presentTask(s.deps.Present, *task), nil
}
