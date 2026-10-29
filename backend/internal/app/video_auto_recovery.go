package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

const (
	videoRecoveryBatch           = 4
	videoRecoveryPassTimeout     = 30 * time.Second
	videoRecoveryRetentionWindow = 24 * time.Hour
	videoRecoveryDefaultBackoff  = 30 * time.Second
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
		s.recordMissingVideoReceiptOutcome(task, task.UserID)
		return nil
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
	if !imageRecoveryNeedsPolling(*task) {
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
	defer func() {
		_ = s.repo.ReleaseTaskProviderRecovery(task.ID, owner)
	}()
	current, err := s.repo.Task(task.ID)
	if err != nil {
		return err
	}
	if current.LeaseOwner != owner || current.Status != model.TaskStatusFailed || !videoRecoveryNeedsPolling(*current) {
		return nil
	}
	if task.ProviderRequestID != "" && current.ProviderRequestID == "" {
		current.ProviderRequestID = task.ProviderRequestID
	}
	return fn(current)
}

func (s *Service) recordMissingVideoReceiptOutcome(task *model.Task, claimUserID string) {
	if task == nil {
		return
	}
	if managedTaskConnection(*task) {
		s.deferManagedVideoQuery(task, claimUserID)
		return
	}
	outcome := localtask.RecoveryUnrecoverable
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil && attempt.RouteRun == task.RouteRun {
		if attempt.DispatchState == "not_sent" || attempt.DispatchState == "rejected_no_job" {
			outcome = localtask.RecoveryNoResult
		}
	}
	_ = s.withFailedVideoRecoveryLease(task, claimUserID, func(leased *model.Task) error {
		return s.repo.FinishFailedVideoRecovery(*leased, &outcome, nil)
	})
	task.RecoveryOutcome = &outcome
}

func (s *Service) recordUnrecoverableVideoOutcome(task *model.Task, claimUserID string) {
	if task == nil {
		return
	}
	if managedTaskConnection(*task) {
		s.deferManagedVideoQuery(task, claimUserID)
		return
	}
	outcome := localtask.RecoveryUnrecoverable
	_ = s.withFailedVideoRecoveryLease(task, claimUserID, func(leased *model.Task) error {
		return s.repo.FinishFailedVideoRecovery(*leased, &outcome, nil)
	})
	task.RecoveryOutcome = &outcome
}

func classifyFailedVideoQueryOutcome(task model.Task, providerStatus string, err error) string {
	if managedTaskConnection(task) {
		if isTerminalVideoProviderStatus(providerStatus) && (task.BeefUsageState != nil || task.BeefBillingState != nil) {
			return localtask.RecoveryNoResult
		}
		return ""
	}
	var dns *outbound.DNSResolutionError
	if errors.As(err, &dns) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return ""
	}
	if isTerminalVideoProviderStatus(providerStatus) {
		return localtask.RecoveryNoResult
	}
	var payloadErr generation.PayloadError
	if errors.As(err, &payloadErr) {
		return localtask.RecoveryNoResult
	}
	if isUnrecoverableVideoQueryError(err) || videoTaskPastRetentionWindow(task, time.Now()) {
		return localtask.RecoveryUnrecoverable
	}
	return ""
}

func videoSettlementNeedsPolling(task model.Task) bool {
	return task.BeefUsageState != nil && strings.EqualFold(strings.TrimSpace(*task.BeefUsageState), "pending")
}

func videoRecoveryNeedsPolling(task model.Task) bool {
	return task.RecoveryOutcome == nil || *task.RecoveryOutcome == "" || videoSettlementNeedsPolling(task)
}

func isTerminalVideoProviderStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "failure", "error", "cancelled", "canceled", "expired":
		return true
	default:
		return false
	}
}

func isUnrecoverableVideoQueryError(err error) bool {
	if err == nil {
		return false
	}
	var upstream providerHTTPError
	if errors.As(err, &upstream) && (upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "该任务的请求协议不支持安全查询上游状态") ||
		strings.Contains(msg, "上游返回的任务 ID 与原视频任务不一致") ||
		strings.Contains(msg, "RunningHub 返回的任务 ID 与原请求不一致") ||
		strings.Contains(msg, "超分回执与原任务不一致") ||
		strings.Contains(msg, "任务输入解析失败") ||
		strings.Contains(msg, "该任务没有可恢复的上游任务 ID")
}

func videoTaskPastRetentionWindow(task model.Task, now time.Time) bool {
	if managedTaskConnection(task) {
		return false
	}
	anchor := task.CreatedAt
	if task.StartedAt != nil && !task.StartedAt.IsZero() {
		anchor = *task.StartedAt
	}
	return !anchor.IsZero() && now.Sub(anchor) >= videoRecoveryRetentionWindow
}

func (s *Service) deferManagedVideoQuery(task *model.Task, user string) {
	next := time.Now().Add(videoRecoveryPollBackoff(*task))
	_ = s.withFailedVideoRecoveryLease(task, user, func(leased *model.Task) error { return s.repo.FinishFailedVideoRecovery(*leased, nil, &next) })
	task.NextPollAt = &next
}

func videoRecoveryPollBackoff(task model.Task) time.Duration {
	anchor := task.CreatedAt
	if task.StartedAt != nil && !task.StartedAt.IsZero() {
		anchor = *task.StartedAt
	}
	if anchor.IsZero() {
		return videoRecoveryDefaultBackoff
	}
	age := time.Since(anchor)
	switch {
	case age < 10*time.Minute:
		return 15 * time.Second
	case age < time.Hour:
		return 30 * time.Second
	default:
		return 2 * time.Minute
	}
}
