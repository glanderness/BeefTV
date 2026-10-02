package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"infinite-canvas/backend/internal/platform"
)

type SubmissionUnknownError struct{ Cause error }

func (e SubmissionUnknownError) Error() string {
	return fmt.Sprintf("提交结果尚未确认：%v", e.Cause)
}

func (e SubmissionUnknownError) Unwrap() error { return e.Cause }

func SafeRouteRejection(err error) bool {
	if err == nil {
		return false
	}
	if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
		return true
	}
	var upstream HTTPError
	if errors.As(err, &upstream) {
		switch upstream.StatusCode {
		case http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden, http.StatusNotFound, http.StatusTooManyRequests:
			return true
		}
	}
	return false
}

func UncertainVideoSubmission(ctx context.Context, err error) error {
	if err == nil || errors.Is(err, context.Canceled) || SafeRouteRejection(err) {
		return err
	}
	var circuit CircuitOpenError
	if errors.As(err, &circuit) {
		return err
	}
	if retry, _ := RetryableVideoPollError(context.Background(), err); retry {
		return SubmissionUnknownError{Cause: err}
	}
	return err
}
