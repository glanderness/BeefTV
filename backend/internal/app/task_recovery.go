package app

import (
	"context"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

// TaskRecoveryResult is the public, query-only recovery projection. A recovery
// request never admits a new local task and never submits a new provider task.
type TaskRecoveryResult struct {
	Task           *model.Task `json:"task"`
	ProviderStatus string      `json:"providerStatus,omitempty"`
	Recovered      bool        `json:"recovered"`
	QueryOnly      bool        `json:"queryOnly"`
}

// RecoverTask restores an already accepted result or queries the original
// provider task. It deliberately does not call RetryTask: /recover is a free
// read/retrieve operation, not a second submission path.
func (s *Service) RecoverTask(ctx context.Context, userID, taskID string) (*TaskRecoveryResult, error) {
	task, err := s.repo.TaskForUser(strings.TrimSpace(userID), strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, BadAuthRequest("任务不存在")
	}
	if task.Status == model.TaskStatusSucceeded {
		if deliveryPaused(task.Stage) {
			resumed, err := s.resumeGenerationDownload(*task)
			if err != nil {
				return nil, err
			}
			return &TaskRecoveryResult{Task: taskForOutput(*resumed), Recovered: true, QueryOnly: true}, nil
		}
		if err := s.DeliverSucceededTask(*task); err != nil {
			return nil, err
		}
		latest, err := s.repo.TaskForUser(userID, taskID)
		if err != nil {
			return nil, err
		}
		return &TaskRecoveryResult{Task: taskForOutput(*latest), Recovered: true, QueryOnly: true}, nil
	}
	if task.Status != model.TaskStatusFailed {
		return &TaskRecoveryResult{Task: taskForOutput(*task), QueryOnly: true}, nil
	}

	if generation.UpscaleMediaType(task.Model) == "" && task.Type == "canvas_image" {
		restored, handled, err := s.recoverAcceptedImage(*task)
		if err != nil {
			return nil, err
		}
		if handled {
			return &TaskRecoveryResult{Task: restored, Recovered: restored != nil && restored.Status == model.TaskStatusSucceeded, QueryOnly: true}, nil
		}
		return &TaskRecoveryResult{Task: taskForOutput(*task), QueryOnly: true}, nil
	}
	if !isRecoverableVideoTask(*task) {
		return nil, BadAuthRequest("该任务不支持安全取回")
	}

	provider, err := s.QueryFailedVideoTask(ctx, userID, taskID)
	if err != nil {
		return nil, err
	}
	return &TaskRecoveryResult{
		Task:           provider.Task,
		ProviderStatus: provider.ProviderStatus,
		Recovered:      provider.Recovered,
		QueryOnly:      true,
	}, nil
}

func isRecoverableVideoTask(task model.Task) bool {
	return strings.HasPrefix(task.Type, "canvas_video") ||
		strings.HasPrefix(task.Type, "video_") ||
		generation.UpscaleMediaType(task.Model) != ""
}
