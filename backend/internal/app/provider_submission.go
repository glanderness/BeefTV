package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"infinite-canvas/backend/internal/model"
)

type providerSubmissionKeyContext struct{}

// A lost receipt is not a rejected generation. Only gateways with a verified
// idempotency contract may replay creation with the SAME durable attempt key.
type providerSubmissionUnknownError struct{ Cause error }

func (e providerSubmissionUnknownError) Error() string {
	return fmt.Sprintf("提交结果尚未确认：%v", e.Cause)
}
func (e providerSubmissionUnknownError) Unwrap() error { return e.Cause }

func uncertainVideoSubmission(ctx context.Context, err error) error {
	if err == nil || errors.Is(err, context.Canceled) || safeRouteRejection(err) {
		return err
	}
	var circuit providerCircuitOpenError
	if errors.As(err, &circuit) {
		return err
	}
	if retry, _ := retryableVideoPollError(context.Background(), err); retry {
		return providerSubmissionUnknownError{Cause: err}
	}
	return err
}

func withProviderSubmissionKey(ctx context.Context, attempt *model.RouteAttempt) context.Context {
	if attempt == nil {
		return ctx
	}
	// Stable for this persisted attempt across worker/process recovery; an
	// explicitly new user retry or a safely rejected route gets a new attempt.
	key := uuid.NewSHA1(uuid.NameSpaceOID, []byte(attempt.TaskID+":"+attempt.ID)).String()
	return context.WithValue(ctx, providerSubmissionKeyContext{}, key)
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
