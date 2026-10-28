package app

import (
	"context"
	"errors"

	"infinite-canvas/backend/internal/repository"
)

// Runs in the existing delivery-recovery pass, not a separate billing worker.
func (s *Service) recoverFailedProviderTasks(ctx context.Context, limit int) error {
	tasks, err := s.repo.FailedVideoTasksForRecovery(s.providerRecoveryAfterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && s.providerRecoveryAfterID != "" {
		tasks, err = s.repo.FailedVideoTasksForRecovery("", limit)
		if err != nil {
			return err
		}
	}
	var last error
	for _, candidate := range tasks {
		if ctx.Err() != nil || s.IsDraining() {
			return ctx.Err()
		}
		s.providerRecoveryAfterID = candidate.ID
		_, err := s.recoverProviderTask(ctx, &candidate, candidate.UserID, true)
		if err != nil && !errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			last = err
		}
	}
	if len(tasks) < limit {
		s.providerRecoveryAfterID = ""
	}
	return last
}
