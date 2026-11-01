package app

import (
	"context"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/mediaattempt"
	"infinite-canvas/backend/internal/model"
	"time"
)

type providerSubmissionKeyContext = mediaattempt.SubmissionKeyContext

func uncertainVideoSubmission(ctx context.Context, err error) error {
	return generation.UncertainVideoSubmission(ctx, err)
}
func withProviderSubmissionKey(ctx context.Context, attempt *model.RouteAttempt) context.Context {
	return mediaattempt.WithAttempt(ctx, attempt)
}

func (s *Service) createDirectTaskAttempt(task *model.Task) (*model.RouteAttempt, error) {
	if task.Attempts > 1 && task.ProviderRequestID == "" {
		return nil, routeDispatchUncertainError{"旧任务已尝试执行但缺少提交记录，为避免重复创建上游任务已停止自动重发"}
	}
	id, err := s.repo.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	attempt := &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: 1, ChannelModelID: task.ChannelModelID, Status: "selected", DispatchState: "not_sent", StartedAt: time.Now()}
	if task.ProviderRequestID != "" {
		attempt.ProviderRequestID, attempt.DispatchState = task.ProviderRequestID, "accepted"
	}
	if err := s.repo.CreateRouteAttempt(attempt); err != nil {
		return nil, err
	}
	return attempt, nil
}
