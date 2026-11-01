package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/mediaattempt"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

const (
	videoRecoveryBatch          = 4
	videoRecoveryPassTimeout    = 30 * time.Second
	videoRecoveryDefaultBackoff = 30 * time.Second
)

// 每次交付恢复循环最多挂一个短视频/超分恢复批次；慢上游不阻塞下载或画布绑定。
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
			_ = s.log("", "", "warn", "视频与超分自动取回暂缓，将稍后再试", "")
		}
	})
	if !started {
		s.videoRecoveryActive.Store(false)
	}
}

func (s *Service) recoverFailedVideos(ctx context.Context, limit int) error {
	if limit <= 0 {
		limit = videoRecoveryBatch
	}
	tasks, err := s.repo.FailedVideosForRecovery(s.videoRecoveryAfterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && s.videoRecoveryAfterID != "" {
		tasks, err = s.repo.FailedVideosForRecovery("", limit)
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
		if err := s.recoverFailedVideo(ctx, candidate); err != nil && !errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			last = err
		}
	}
	if len(tasks) < limit {
		s.videoRecoveryAfterID = ""
	}
	return last
}

func (s *Service) recoverFailedVideo(ctx context.Context, candidate model.Task) error {
	task, err := s.repo.TaskForUser(candidate.UserID, candidate.ID)
	if err != nil {
		return err
	}
	if task.Status != model.TaskStatusFailed || !videoRecoveryNeedsPolling(*task) {
		return nil
	}
	s.hydrateTaskProviderRequestID(task)
	if strings.TrimSpace(task.ProviderRequestID) == "" {
		_, managed, queryErr := s.managedTaskRecoveryQuery(ctx, *task)
		if queryErr != nil {
			return queryErr
		}
		if !managed {
			s.recordMissingVideoReceiptOutcome(task, task.UserID)
			return nil
		}
	}
	if videoTaskPastRetentionWindow(*task, time.Now()) {
		s.recordUnrecoverableVideoOutcome(task, task.UserID)
		return nil
	}
	res, queryErr := s.queryFailedVideoTask(ctx, task, task.UserID)
	if queryErr == nil && res != nil && res.Recovered {
		return nil
	}
	latest, loadErr := s.repo.TaskForUser(task.UserID, task.ID)
	if loadErr != nil {
		return loadErr
	}
	if latest.Status != model.TaskStatusFailed || !videoRecoveryNeedsPolling(*latest) {
		return queryErr
	}
	next := time.Now().Add(videoRecoveryPollBackoff(*latest))
	_ = s.withFailedVideoRecoveryLease(latest, latest.UserID, func(leased *model.Task) error {
		return s.repo.FinishFailedVideoRecovery(*leased, leased.RecoveryOutcome, &next)
	})
	return queryErr
}

func (s *Service) resumeTaskDeliveryForUser(_ context.Context, userID, taskID string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if deliveryPaused(task.Stage) {
		resumed, err := s.resumeGenerationDownload(*task)
		if err != nil {
			return nil, err
		}
		task = resumed
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		return nil, err
	}
	return s.repo.TaskForUser(userID, taskID)
}

func (s *Service) recoverFailedImageForUser(ctx context.Context, userID, taskID string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if task.Status == model.TaskStatusSucceeded {
		_ = s.DeliverSucceededTask(*task)
		return s.repo.TaskForUser(userID, taskID)
	}
	if !imageRecoveryNeedsPolling(*task) && !s.managedImageNeedsRecheck(*task) {
		return task, nil
	}
	_ = s.recoverFailedImage(ctx, *task)
	updated, err := s.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if updated.Status == model.TaskStatusSucceeded {
		_ = s.DeliverSucceededTask(*updated)
		return s.repo.TaskForUser(userID, taskID)
	}
	return updated, nil
}

func (s *Service) recoverFailedVideoOrUpscaleForUser(ctx context.Context, userID, taskID string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if task.Status == model.TaskStatusSucceeded {
		_ = s.DeliverSucceededTask(*task)
		return s.repo.TaskForUser(userID, taskID)
	}
	if !videoRecoveryNeedsPolling(*task) {
		return task, nil
	}
	_ = s.recoverFailedVideo(ctx, *task)
	return s.repo.TaskForUser(userID, taskID)
}

func (s *Service) withFailedVideoRecoveryLease(task *model.Task, claimUserID string, fn func(*model.Task) error) error {
	if task == nil || task.ID == "" {
		return nil
	}
	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, claimUserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		return err
	}
	defer func() { _ = s.repo.ReleaseTaskProviderRecovery(task.ID, owner) }()
	current, err := s.repo.Task(task.ID)
	if err != nil || current.LeaseOwner != owner || current.Status != model.TaskStatusFailed || !videoRecoveryNeedsPolling(*current) {
		return err
	}
	if task.ProviderRequestID != "" && current.ProviderRequestID == "" {
		current.ProviderRequestID = task.ProviderRequestID
	}
	return fn(current)
}

func (s *Service) recordMissingVideoReceiptOutcome(task *model.Task, claimUserID string) {
	outcome := localtask.RecoveryUnrecoverable
	if task != nil {
		if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil && attempt.RouteRun == task.RouteRun && (attempt.DispatchState == "not_sent" || attempt.DispatchState == "rejected_no_job") {
			outcome = localtask.RecoveryNoResult
		}
	}
	s.recordFailedVideoRecoveryOutcome(task, claimUserID, outcome)
}

func (s *Service) recordUnrecoverableVideoOutcome(task *model.Task, claimUserID string) {
	s.recordFailedVideoRecoveryOutcome(task, claimUserID, localtask.RecoveryUnrecoverable)
}

func (s *Service) recordFailedVideoRecoveryOutcome(task *model.Task, claimUserID, outcome string) {
	if task == nil {
		return
	}
	if beefAPIOwnsVideoConclusion(*task, time.Now()) {
		s.deferManagedVideoQuery(task, claimUserID)
		return
	}
	_ = s.withFailedVideoRecoveryLease(task, claimUserID, func(leased *model.Task) error { return s.repo.FinishFailedVideoRecovery(*leased, &outcome, nil) })
	task.RecoveryOutcome = &outcome
}

func classifyFailedVideoQueryOutcome(task model.Task, providerStatus string, err error) string {
	return mediaattempt.ClassifyFailedVideoQueryOutcome(task, providerStatus, err, time.Now())
}
func videoSettlementNeedsPolling(task model.Task) bool { return task.MediaSettlementPending() }
func videoRecoveryNeedsPolling(task model.Task) bool {
	return task.RecoveryOutcome == nil || *task.RecoveryOutcome == "" || videoSettlementNeedsPolling(task)
}
func videoTaskPastRetentionWindow(task model.Task, now time.Time) bool {
	return mediaattempt.VideoTaskPastRetentionWindow(task, now)
}
func beefAPIOwnsVideoConclusion(task model.Task, now time.Time) bool {
	return mediaattempt.BeefAPIOwnsVideoConclusion(task, now)
}
func (s *Service) deferManagedVideoQuery(task *model.Task, user string) {
	next := time.Now().Add(videoRecoveryPollBackoff(*task))
	_ = s.withFailedVideoRecoveryLease(task, user, func(leased *model.Task) error { return s.repo.FinishFailedVideoRecovery(*leased, nil, &next) })
	task.NextPollAt = &next
}

func videoRecoveryPollBackoff(task model.Task) time.Duration {
	anchor := mediaattempt.VideoTaskAnchor(task)
	if anchor.IsZero() {
		return videoRecoveryDefaultBackoff
	}
	switch age := time.Since(anchor); {
	case age < 10*time.Minute:
		return 15 * time.Second
	case age < time.Hour:
		return 30 * time.Second
	default:
		return 2 * time.Minute
	}
}
