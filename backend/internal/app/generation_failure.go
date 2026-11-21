package app

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/generation"
)

func classifyTaskFailure(err error) generation.Failure {
	return generation.ClassifyTaskFailure(err)
}

func persistableTaskFailureMessage(err error) string {
	return generation.PersistableTaskFailureMessage(err)
}

func taskFailureErrorCode(err error) string {
	return generation.TaskFailureErrorCode(err)
}

func persistedFailureErrorCode(message string, stage string) string {
	return generation.PersistedFailureErrorCode(message, stage)
}

func persistedFailureBlocksRetry(message, stage, errorCode string) bool {
	return generation.PersistedFailureBlocksRetry(message, stage, errorCode)
}

// InterceptResponseText normalizes user-facing provider text without altering raw upstream payloads.
func (s *Service) InterceptResponseText(raw string) string {
	return strings.TrimSpace(raw)
}

// UserFacingErrorMessage projects a user-visible error message without altering stored upstream diagnostics.
func (s *Service) UserFacingErrorMessage(err error) string {
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		return s.InterceptResponseText(providerUserFacingErrorMessage(err))
	}
	return s.InterceptResponseText(taskFailureMessage(err))
}

func (s *Service) UserFacingProviderHTTPError(status int, statusText string, body string) string {
	message := generation.ClassifyHTTP(status, statusText, body).UserMessage()
	if s == nil {
		return message
	}
	return s.InterceptResponseText(message)
}
