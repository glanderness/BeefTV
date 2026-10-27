package app

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/repository"
)

const (
	videoRecoveryBatch       = 4
	videoRecoveryPassTimeout = 15 * time.Second
)

// startVideoRecoveryPass only queries already accepted provider tasks. It is
// intentionally separate from the paid task worker and never calls RetryTask.
func (s *Service) startVideoRecoveryPass(ctx context.Context) {
	if !s.videoRecoveryActive.CompareAndSwap(false, true) {
		return
	}
	started := s.runWorkerTask(func() {
		defer s.videoRecoveryActive.Store(false)
		if ctx.Err() != nil || s.IsDraining() {
			return
		}
		bounded, cancel := context.WithTimeout(ctx, videoRecoveryPassTimeout)
		defer cancel()
		if err := s.recoverFailedVideos(bounded, videoRecoveryBatch); err != nil {
			_ = s.log("", "", "warn", "视频自动查询暂缓，将稍后再试", "")
		}
	})
	if !started {
		s.videoRecoveryActive.Store(false)
	}
}

type automaticGetOnlyRecoveryContextKey struct{}

func withAutomaticGetOnlyRecovery(ctx context.Context) context.Context {
	return context.WithValue(ctx, automaticGetOnlyRecoveryContextKey{}, true)
}

func automaticGetOnlyRecovery(ctx context.Context) bool {
	value, _ := ctx.Value(automaticGetOnlyRecoveryContextKey{}).(bool)
	return value
}

func (s *Service) recoverFailedVideos(ctx context.Context, limit int) error {
	if limit <= 0 {
		limit = videoRecoveryBatch
	}
	tasks, err := s.repo.FailedVideoTasksForRecovery(s.videoRecoveryAfterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && s.videoRecoveryAfterID != "" {
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
		s.videoRecoveryAfterID = candidate.ID
		autoCtx := withAutomaticGetOnlyRecovery(ctx)
		if _, err := s.QueryFailedVideoTask(autoCtx, candidate.UserID, candidate.ID); err != nil && !errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			last = err
			nextPollAt := time.Now().Add(30 * time.Second)
			if updateErr := s.repo.UpdateTaskProviderState(candidate.ID, candidate.ProviderRequestID, candidate.PollStage, &nextPollAt); updateErr != nil {
				last = errors.Join(last, updateErr)
			}
		}
	}
	if len(tasks) < limit {
		s.videoRecoveryAfterID = ""
	}
	return last
}
