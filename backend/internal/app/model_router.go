package app

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func (s *Service) invalidateRouteCatalog() {
	if s == nil {
		return
	}
	s.ensureRouter().Invalidate(context.Background())
}

func (s *Service) routeCatalogSnapshot() (*routeCatalogSnapshot, error) {
	return s.ensureRouter().Snapshot()
}

func (s *Service) ResolveLogicalModel(logicalModelID string, intent ModelRequestIntent) (*RoutedModel, error) {
	return s.ensureRouter().ResolveLogicalModel(logicalModelID, intent)
}

func (s *Service) createRouteAttempt(task *model.Task, routed *RoutedModel, attemptNumber int) (*model.RouteAttempt, error) {
	return s.ensureRouter().CreateRouteAttempt(s.routeStore(), task, routed, attemptNumber)
}

func (s *Service) beginTaskRouteAttempt(task *model.Task) (*model.RouteAttempt, error) {
	if task == nil {
		return nil, nil
	}
	attempts, err := s.repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil {
		return nil, err
	}
	image := modelcatalog.ImageSubmissionView{}
	if len(attempts) > 0 {
		existing := &attempts[len(attempts)-1]
		if managedTaskConnection(*task) || existing.ChannelID == beefapi.ChannelID {
			managedReceipt := false
			if task.Type != "canvas_image" && existing.DispatchState != "not_sent" {
				if row, err := s.repo.ImageSubmission(existing.ID, task.ID, task.UserID); err == nil {
					query, managed, queryErr := s.managedTaskQuery(context.Background(), *task, row)
					managedReceipt = queryErr == nil && managed && !query.Legacy
				}
			}
			if task.Type == "canvas_image" && existing.DispatchState != "not_sent" {
				if _, err := s.repo.ImageSubmission(existing.ID, task.ID, task.UserID); err != nil {
					return nil, imageRecoveryError{errors.New("原任务发送信息暂不可用，尚未确认结果")}
				}
			}
			// Restarting an authorized attempt never authorizes a new paid one.
			// The existing executor/query path owns this original identity.
			if existing.DispatchState == "not_sent" || existing.ProviderRequestID != "" || managedReceipt || (task.Type == "canvas_image" && (existing.DispatchState == "accepted" || existing.DispatchState == "submission_unknown")) {
				if task.ProviderRequestID == "" && existing.ProviderRequestID != "" {
					task.ProviderRequestID = existing.ProviderRequestID
					if err := s.repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
						return nil, err
					}
				}
				return existing, nil
			}
			return nil, imageRecoveryError{errors.New("原任务已提交，尚未确认结果")}
		}
		if task.Type == "canvas_image" && (existing.DispatchState == "submission_unknown" || existing.DispatchState == "accepted") {
			image = s.imageSubmissionView(existing, task)
		}
	}
	decision := modelcatalog.DecideExistingAttempt(task, attempts, image)
	switch decision.Action {
	case modelcatalog.AttemptReuse:
		return decision.Attempt, nil
	case modelcatalog.AttemptReuseAccepted:
		if decision.SyncProviderRequest {
			task.ProviderRequestID = decision.Attempt.ProviderRequestID
			if err := s.repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
				return nil, err
			}
		}
		if decision.MarkAccepted {
			decision.Attempt.DispatchState = "accepted"
			if err := s.repo.SaveRouteAttempt(decision.Attempt); err != nil {
				return nil, err
			}
		}
		return decision.Attempt, nil
	case modelcatalog.AttemptUncertain, modelcatalog.AttemptFail:
		return nil, decision.Error
	case modelcatalog.AttemptRetryImage:
		if next, err := s.retryRejectedImageAttempt(task, decision.Attempt, providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`}); next != nil || err != nil {
			return next, err
		}
		return nil, errors.New("上游已拒绝本次图片请求，请查看失败原因")
	case modelcatalog.AttemptSwitchRoute:
		return s.switchTaskToNextRoute(task, attempts)
	case modelcatalog.AttemptCreateDirect:
		return s.createDirectTaskAttempt(task)
	case modelcatalog.AttemptCreateSelected:
		routed, routeErr := s.routedModelForTaskSelection(task)
		if routeErr != nil {
			return s.switchTaskToNextRoute(task, attempts)
		}
		return s.createRouteAttempt(task, routed, len(attempts)+1)
	default:
		if task.LogicalModelID == "" {
			return s.createDirectTaskAttempt(task)
		}
		routed, routeErr := s.routedModelForTaskSelection(task)
		if routeErr != nil {
			return s.switchTaskToNextRoute(task, attempts)
		}
		return s.createRouteAttempt(task, routed, len(attempts)+1)
	}
}

func (s *Service) markRouteAttemptDispatching(attempt *model.RouteAttempt) error {
	return modelcatalog.MarkRouteAttemptDispatching(s.routeStore(), attempt)
}

func (s *Service) routedModelForTaskSelection(task *model.Task) (*RoutedModel, error) {
	return s.ensureRouter().RoutedModelForTaskSelection(s.routeStore(), task)
}

func (s *Service) switchTaskToNextRoute(task *model.Task, attempts []model.RouteAttempt) (*model.RouteAttempt, error) {
	return s.ensureRouter().SwitchTaskToNextRoute(s.routeStore(), s.taskInputCodec(), task, attempts)
}

func (s *Service) nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	if task != nil {
		if config, ok := s.resolveImageRecoveryConfig(*task); ok && config.CredentialRef == beefapi.CredentialRef {
			return nil, nil
		}
	}
	info := routeFailureInfo(taskErr)
	if task != nil && task.Type == "canvas_image" && attempt != nil {
		if !modelcatalog.ShouldRetryImageThrottle(task, attempt, info) {
			return nil, nil
		}
		if _, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err != nil {
			return nil, nil
		}
		return s.retryRejectedImageAttempt(task, attempt, taskErr)
	}
	if !modelcatalog.ShouldSwitchRouteAfterFailure(task, attempt, info) {
		return nil, nil
	}
	s.ensureRouter().BlockLogicalRouteForFailure(attempt, info)
	attempts, err := s.repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil {
		return nil, err
	}
	return s.switchTaskToNextRoute(task, attempts)
}

func (s *Service) prepareLogicalTaskRetry(task *model.Task, input map[string]any) error {
	return s.ensureRouter().PrepareLogicalTaskRetry(s.routeStore(), s.taskInputCodec(), task, input)
}

func (s *Service) resolveArchivedTaskRoute(task *model.Task, intent ModelRequestIntent) (*RoutedModel, error) {
	return s.ensureRouter().ResolveArchivedTaskRoute(s.routeStore(), task, intent)
}

func (s *Service) finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error) {
	image := modelcatalog.ImageSubmissionView{}
	info := routeFailureInfo(taskErr)
	if task != nil && task.Type == "canvas_image" {
		image = s.imageSubmissionView(attempt, task)
		info.ExplicitRejection = info.ExplicitRejection || definiteImageInputRejection(taskErr)
	}
	modelcatalog.FinishRouteAttempt(s.routeStore(), attempt, task, taskErr, taskFailureMessage(taskErr), info, image, time.Now)
}
