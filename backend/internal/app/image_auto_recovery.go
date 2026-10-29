package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

const imageRecoveryBatch = 8
const imageRecoveryPassTimeout = 15 * time.Second

// 每次下载循环最多挂一个短图片恢复批次；慢上游不阻塞下载、画布写回。
func (s *Service) startImageRecoveryPass(ctx context.Context) {
	if !s.imageRecoveryActive.CompareAndSwap(false, true) {
		return
	}
	started := s.runWorkerTask(func() {
		defer s.imageRecoveryActive.Store(false)
		if ctx.Err() != nil || s.IsDraining() {
			return
		}
		bounded, cancel := context.WithTimeout(ctx, imageRecoveryPassTimeout)
		defer cancel()
		if err := s.recoverFailedImages(bounded, imageRecoveryBatch); err != nil {
			// 不记录原请求、响应或上游错误正文。
			_ = s.log("", "", "warn", "图片自动取回暂缓，将稍后再试", "")
		}
	})
	if !started {
		s.imageRecoveryActive.Store(false)
	}
}

func (s *Service) recoverFailedImages(ctx context.Context, limit int) error {
	if limit <= 0 {
		limit = imageRecoveryBatch
	}
	tasks, err := s.repo.FailedImagesForRecovery(s.imageRecoveryAfterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && s.imageRecoveryAfterID != "" {
		tasks, err = s.repo.FailedImagesForRecovery("", limit)
		if err != nil {
			return err
		}
	}
	var last error
	for _, candidate := range tasks {
		if ctx.Err() != nil || s.IsDraining() {
			return ctx.Err()
		}
		s.imageRecoveryAfterID = candidate.ID
		if err := s.recoverFailedImage(ctx, candidate); err != nil && !errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			last = err
		}
	}
	if len(tasks) < limit {
		s.imageRecoveryAfterID = ""
	}
	return last
}

func imageSettlementNeedsPolling(task model.Task) bool {
	return task.BeefBillingState != nil && strings.TrimSpace(*task.BeefBillingState) == ""
}

func imageRecoveryNeedsPolling(task model.Task) bool {
	return task.RecoveryOutcome == nil || *task.RecoveryOutcome == "" || imageSettlementNeedsPolling(task)
}

// Earlier clients could conclude that an API task was unrecoverable from its
// local request age. Only the API can now confirm that conclusion.
func (s *Service) managedImageNeedsRecheck(task model.Task) bool {
	if task.RecoveryOutcome == nil || *task.RecoveryOutcome != localtask.RecoveryUnrecoverable {
		return false
	}
	if managedTaskConnection(task) {
		return true
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil || attempt == nil || attempt.RouteRun != task.RouteRun {
		return false
	}
	if attempt.ChannelID == beefapi.ChannelID {
		return true
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	return err == nil && row.QueryCipher != ""
}

func (s *Service) recoverFailedImage(ctx context.Context, candidate model.Task) error {
	if generation.UpscaleMediaType(candidate.Model) != "" {
		return nil
	}
	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(candidate.ID, candidate.UserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		return err
	}
	defer s.repo.ReleaseTaskProviderRecovery(candidate.ID, owner)
	// 领取后重新读取，不能使用扫描时的旧 routeRun 或终态结论。
	task, err := s.repo.TaskForUser(candidate.UserID, candidate.ID)
	if err != nil {
		return err
	}
	recheck := s.managedImageNeedsRecheck(*task)
	if task.LeaseOwner != owner || task.Status != model.TaskStatusFailed || (!imageRecoveryNeedsPolling(*task) && !recheck) {
		return nil
	}
	var outcome string
	var recoveryErr error
	if task.RecoveryOutcome != nil && *task.RecoveryOutcome != "" && !recheck {
		outcome = *task.RecoveryOutcome
	} else {
		var result []byte
		result, outcome, recoveryErr = s.failedImageResult(ctx, *task)
		if task.ImageJobID == "" {
			if latest, loadErr := s.repo.Task(task.ID); loadErr == nil && latest != nil && latest.ImageJobID != "" {
				task.ImageJobID = latest.ImageJobID
			}
		}
		if len(result) > 0 && recoveryErr == nil {
			task.Error, task.FailureDiagnostics = "", nil
			if err := s.saveTaskCompletionWithinStorageQuota(task, result, nil, false); err == nil {
				return nil
			} else {
				recoveryErr = err
			}
		}
	}
	settlementErr := s.syncFailedImageBeefSettlement(ctx, task)
	if recoveryErr == nil && settlementErr != nil {
		recoveryErr = settlementErr
	}
	var conclusion *string
	var next *time.Time
	if outcome != "" {
		conclusion = &outcome
	}
	if outcome == "" || imageSettlementNeedsPolling(*task) || (task.ImageJobID != "" && task.BeefBillingState == nil && settlementErr != nil) {
		// 暂时失败或对账未完成时继续轮询。发送次数只影响退避，不再把 12 次当成结果丢失。
		delay := 30 * time.Second
		if a, loadErr := s.repo.LatestRouteAttempt(task.ID); loadErr == nil {
			if row, loadErr := s.repo.ImageSubmission(a.ID, task.ID, task.UserID); loadErr == nil {
				delay = min(15*time.Minute, 30*time.Second*time.Duration(1<<min(row.SendCount, 5)))
			}
		}
		at := time.Now().Add(delay)
		next = &at
	}
	if err := s.repo.FinishFailedImageRecovery(*task, conclusion, next); err != nil {
		return err
	}
	return recoveryErr
}

func (s *Service) resolveImageRecoveryConfig(task model.Task) (generation.Config, bool) {
	var config generation.Config
	if decrypted, err := s.decryptTaskInputJSON(task.InputJSON); err == nil && strings.TrimSpace(decrypted) != "" {
		var input canvasGenerationInput
		if json.Unmarshal([]byte(decrypted), &input) == nil {
			config = input.Config
		}
	}
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil {
		if config.ChannelID == "" && attempt.ChannelID != "" {
			config.ChannelID = attempt.ChannelID
		}
		if row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err == nil && row != nil {
			if wire, err := s.imageSubmissionWire(row); err == nil {
				if config.ChannelID == "" && wire.ChannelID != "" {
					config.ChannelID = wire.ChannelID
				}
				if config.BaseURL == "" && wire.URL != "" {
					if idx := strings.Index(wire.URL, "/v1/"); idx > 0 {
						config.BaseURL = wire.URL[:idx+3]
					}
				}
				if config.APIKey == "" && wire.Header != nil {
					auth := strings.TrimSpace(wire.Header.Get("Authorization"))
					if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
						config.APIKey = strings.TrimSpace(auth[7:])
					}
				}
			}
		}
	}
	if resolved, err := s.resolveProviderConfig(config); err == nil {
		config = resolved
	}
	return config, strings.TrimSpace(config.BaseURL) != ""
}

func (s *Service) syncFailedImageBeefSettlement(ctx context.Context, task *model.Task) error {
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil {
		if row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err == nil {
			queryCtx := context.WithValue(ctx, imageTaskContext{}, *task)
			client, key, _, managed, queryErr := s.managedImageQueryClient(queryCtx, *task, row)
			if managed {
				if queryErr != nil {
					return queryErr
				}
				if latest, err := s.repo.Task(task.ID); err == nil && latest.BeefBillingState != nil && strings.TrimSpace(*latest.BeefBillingState) != "" {
					task.BeefBillingState, task.BeefReconcileDeadline = latest.BeefBillingState, latest.BeefReconcileDeadline
					return nil
				}
				_, err := client.Query(queryCtx, key, "image")
				if latest, loadErr := s.repo.Task(task.ID); loadErr == nil {
					task.BeefBillingState, task.BeefReconcileDeadline = latest.BeefBillingState, latest.BeefReconcileDeadline
				}
				return err
			}
		}
	}
	if task == nil {
		return nil
	}
	if strings.TrimSpace(task.ImageJobID) == "" {
		if receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID); err == nil && receipt != nil {
			if jobID := generation.ExtractBeefAPIImageJobID(nil, []byte(receipt.ResponseBody)); jobID != "" {
				task.ImageJobID = jobID
				_ = s.repo.UpdateTaskImageJobID(task.ID, jobID)
			}
		}
	}
	if strings.TrimSpace(task.ImageJobID) == "" || (task.BeefBillingState != nil && strings.TrimSpace(*task.BeefBillingState) != "") {
		return nil
	}
	config, ok := s.resolveImageRecoveryConfig(*task)
	if !ok {
		return nil
	}
	queryCtx := ctx
	if s.coordinator != nil {
		queryCtx = withProviderAnalytics(queryCtx, s, *task)
	}
	queryCtx = bindRequestReceipts(queryCtx)
	settlement, _, err := generation.QueryBeefAPIImageJob(queryCtx, config, task.ImageJobID)
	if err != nil {
		return err
	}
	if settlement.HasBillingState && settlement.BillingState != nil {
		normalized := strings.ToLower(strings.TrimSpace(*settlement.BillingState))
		task.BeefBillingState = &normalized
	}
	if settlement.ReconcileDeadline != nil {
		trimmed := strings.TrimSpace(*settlement.ReconcileDeadline)
		if trimmed == "" {
			task.BeefReconcileDeadline = nil
		} else {
			task.BeefReconcileDeadline = &trimmed
		}
	} else if settlement.HasBillingState && task.BeefBillingState != nil && strings.TrimSpace(*task.BeefBillingState) != "" {
		task.BeefReconcileDeadline = nil
	}
	if settlement.HasBillingState || settlement.ReconcileDeadline != nil {
		_ = s.repo.UpdateTaskBeefImageSettlement(task.ID, task.BeefBillingState, task.BeefReconcileDeadline)
	}
	return nil
}

func (s *Service) failedImageResult(ctx context.Context, task model.Task) ([]byte, string, error) {
	return s.failedImageResultWith(ctx, task, func(req *http.Request, admit func() error) ([]byte, string, error) {
		return generation.DoBinaryWithDispatchAdmission(withHTTPRequestRuntime(req), admit)
	})
}

func (s *Service) failedImageResultWith(ctx context.Context, task model.Task, send func(*http.Request, func() error) ([]byte, string, error)) ([]byte, string, error) {
	all, err := s.repo.ImageRecoveryEvidence([]string{task.ID})
	if err != nil {
		return nil, "", err
	}
	evidence := all[task.ID]
	attempt, submission := evidence.Attempt, evidence.Submission
	if (managedTaskConnection(task) || (attempt != nil && attempt.ChannelID == beefapi.ChannelID)) && (attempt == nil || submission == nil || attempt.RouteRun != task.RouteRun) {
		return nil, "", imageRecoveryError{errors.New("原任务查询信息暂不可用，尚未确认结果")}
	}
	if attempt != nil && submission != nil && attempt.RouteRun == task.RouteRun {
		row, loadErr := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
		if loadErr != nil {
			return nil, "", loadErr
		}
		queryCtx := context.WithValue(withProviderAnalytics(ctx, s, task), imageTaskContext{}, task)
		if recovered, managed, collectErr := s.collectManagedImage(queryCtx, task, row); managed {
			if collectErr != nil {
				var terminal *beefapi.MediaTaskError
				if errors.As(collectErr, &terminal) {
					return nil, localtask.RecoveryNoResult, nil
				}
				return nil, "", collectErr
			}
			body, marshalErr := json.Marshal(recovered)
			return body, "", marshalErr
		}
	}
	receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
	// 同键恢复也会追加创建日志。历史日志有歧义时不能挑一个旧成功结果，
	// 但仍可由当前轮次的冻结请求及原键向网关取回确切回执。
	if err != nil && !errors.Is(err, repository.ErrAmbiguousImageCreateReceipts) {
		return nil, "", err
	}
	if receipt != nil && attempt != nil {
		started := receipt.StartedAt
		if started.IsZero() {
			started = receipt.CreatedAt
		}
		if attempt.RouteRun != task.RouteRun || started.Before(attempt.StartedAt) {
			receipt = nil
		}
	}
	result, _, receiptErr := imageResultFromReceiptContext(ctx, receipt)
	var dns *outbound.DNSResolutionError
	if errors.As(receiptErr, &dns) || errors.Is(receiptErr, context.Canceled) || errors.Is(receiptErr, context.DeadlineExceeded) {
		return nil, "", receiptErr
	}
	if len(result) > 0 && receiptErr == nil {
		return result, "", nil
	}

	if attempt != nil && attempt.RouteRun == task.RouteRun && attempt.DispatchState == "rejected_no_job" && (submission == nil || !submission.ResponseAccepted) {
		return nil, localtask.RecoveryNoResult, nil
	}
	if receipt != nil {
		if conclusion := imageReceiptConclusion(receipt.StatusCode, receipt.ResponseBody); conclusion != "" {
			return nil, conclusion, nil
		}
	}
	if submission == nil || attempt == nil || attempt.RouteRun != task.RouteRun || (attempt.DispatchState != "accepted" && attempt.DispatchState != "submission_unknown") {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	// 仅实际恢复需要读取完整冻结请求，读投影始终只查询小字段。
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	if err != nil {
		return nil, "", err
	}
	if row.RequestCipher == "" || time.Since(row.CreatedAt) >= imageRecoveryLifetime {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	safe, err := s.safeFrozenImageReplay(task, attempt, row)
	if err != nil {
		return nil, "", err
	}
	if !safe {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	wire, err := s.imageSubmissionWire(row)
	if err != nil {
		return nil, "", err
	}
	available, err := s.imageRecoveryChannelAvailable(attempt, wire)
	if err != nil {
		return nil, "", err
	}
	if !available {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	ctx = withProviderAnalytics(ctx, s, task)
	metadata := canonicalCallMeta(ctx)
	metadata.ChannelID = firstNonEmpty(attempt.ChannelID, wire.ChannelID)
	ctx = s.bindGenerationRuntime(ctx, metadata)
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	data, _, sendErr := s.sendImageSubmissionWithMode(bounded, task, row, send, sleepContext, true)
	if sendErr != nil {
		if errors.Is(sendErr, errImageRecoveryIdentityUnavailable) {
			return nil, localtask.RecoveryUnrecoverable, nil
		}
		var upstream providerHTTPError
		if errors.As(sendErr, &upstream) {
			if upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden {
				return nil, localtask.RecoveryUnrecoverable, nil
			}
			switch imageReceiptErrorCode(upstream.Body) {
			case "image_result_unknown", "image_result_expired", "idempotency_conflict":
				return nil, localtask.RecoveryUnrecoverable, nil
			}
			// 原键的明确终态失败并不代表未计费。
			if upstream.IdempotencyReplayed && upstream.StatusCode >= 400 && upstream.StatusCode < 500 && upstream.StatusCode != 408 && upstream.StatusCode != 409 && upstream.StatusCode != 429 {
				return nil, localtask.RecoveryNoResult, nil
			}
		}
		return nil, "", sendErr
	}
	if conclusion := imageReceiptConclusion(http.StatusOK, string(data)); conclusion != "" {
		return nil, conclusion, nil
	}
	var payload imageResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, "", err
	}
	images, err := imageDataURLs(payload)
	if err != nil {
		return nil, "", err
	}
	result, err = json.Marshal(map[string]any{"mode": "image", "images": images})
	return result, "", err
}

func imageReceiptConclusion(statusCode int, body string) string {
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return localtask.RecoveryUnrecoverable
	}
	switch imageReceiptErrorCode(body) {
	case "image_result_unknown", "image_result_expired", "idempotency_conflict":
		return localtask.RecoveryUnrecoverable
	case "image_submission_pending", "image_submission_unavailable", "image_result_unavailable":
		return ""
	}
	// 通用 HTTP 错误正文不是生成终态；408/429/5xx 等仍可按原键取回。
	if statusCode < http.StatusOK || statusCode >= http.StatusMultipleChoices {
		return ""
	}
	var payload map[string]any
	if json.Unmarshal([]byte(body), &payload) == nil {
		if _, _, failed := generation.PayloadBusinessFailure(payload); failed {
			return localtask.RecoveryNoResult
		}
	}
	return ""
}

func imageReceiptErrorCode(body string) string {
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(body), &payload)
	return payload.Error.Code
}

func (s *Service) safeFrozenImageReplay(task model.Task, attempt *model.RouteAttempt, row *model.ImageSubmission) (bool, error) {
	if row == nil || attempt == nil || row.TaskID != task.ID || row.UserID != task.UserID || row.AttemptID != attempt.ID || row.RequestCipher == "" {
		return false, nil
	}
	plain, err := s.decryptSettingSecret(row.RequestCipher)
	if err != nil {
		return false, err
	}
	var wire imageWireRequest
	if json.Unmarshal([]byte(plain), &wire) != nil {
		return false, nil
	}
	if wire.ReplayProtocol != generation.ImageReplayProtocol || len(wire.Body) == 0 {
		return false, nil
	}
	ctx := withProviderSubmissionKey(context.Background(), attempt)
	key, _ := ctx.Value(providerSubmissionKeyContext{}).(string)
	if wire.Header.Get("Idempotency-Key") != key {
		return false, nil
	}
	req, err := http.NewRequestWithContext(generation.WithImageReplayProtocol(ctx, wire.ReplayProtocol), http.MethodPost, wire.URL, nil)
	return err == nil && recoverableImageEndpoint(req), nil
}
