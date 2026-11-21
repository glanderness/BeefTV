package app

import (
	"context"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) managedTaskQuery(ctx context.Context, task model.Task, row *model.ImageSubmission) (managedMediaQuery, bool, error) {
	return s.mediaAttempts().ManagedTaskQuery(ctx, task, row)
}

func (s *Service) managedTaskRecoveryQuery(ctx context.Context, task model.Task) (managedMediaQuery, bool, error) {
	return s.mediaAttempts().ManagedTaskRecoveryQuery(ctx, task)
}
