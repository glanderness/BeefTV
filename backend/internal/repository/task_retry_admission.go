package repository

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func saveRetryAdmission(tx *gorm.DB, userID, operationID, payloadHash, action string, originalRun int, task *model.Task) error {
	identity := model.TaskRetryOperation{TaskID: task.ID, Action: action, OriginalRouteRun: originalRun, AcceptedRouteRun: task.RouteRun}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return err
	}
	now := time.Now()
	// A running free receipt can survive an old candidate's process exit.
	// Complete its local admission; no network execution is locked by it.
	updated := tx.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ? AND op = ? AND payload_hash = ? AND status = ?", userID, operationID, "task.retry", payloadHash, "running").
		Updates(map[string]any{"status": "succeeded", "result_json": string(encoded), "updated_at": now})
	if updated.Error != nil {
		return updated.Error
	}
	if updated.RowsAffected == 0 {
		if err := tx.Create(&model.AgentOpRecord{UserID: userID, Op: "task.retry", OpID: operationID, PayloadHash: payloadHash, Status: "succeeded", ResultJSON: string(encoded), CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			return err
		}
	}
	task.RetryOperation = &identity
	return nil
}

// AdmitFreeRetry commits the operation identity together with the resumable
// task state. The existing recovery/delivery workers own network I/O afterward.
func (r *Repository) AdmitFreeRetry(userID, operationID, payloadHash string, expected model.Task) (*model.Task, bool, error) {
	var task model.Task
	accepted := false
	err := withImmediateTransaction(r.db, func(tx *gorm.DB) error {
		replayed, found, err := retryOperationResult(tx, userID, operationID, expected.ID)
		if err != nil && !errors.Is(err, ErrRetryOperationInProgress) {
			return err
		}
		if found {
			task = *replayed
			return errRetryOperationReplayed
		}
		if errors.Is(err, ErrRetryOperationInProgress) {
			var record model.AgentOpRecord
			if err := tx.First(&record, "user_id = ? AND op_id = ?", userID, operationID).Error; err != nil {
				return err
			}
			if record.PayloadHash != payloadHash {
				return ErrRetryOperationConflict
			}
		}
		if err := tx.First(&task, "id = ? AND user_id = ?", expected.ID, userID).Error; err != nil {
			return err
		}
		if task.RouteRun != expected.RouteRun || task.Status != expected.Status || task.Stage != expected.Stage {
			return ErrTaskStateConflict
		}
		updates := map[string]any{"updated_at": time.Now()}
		if task.Status == model.TaskStatusSucceeded && (task.Stage == "delivery_paused" || task.Stage == "delivery_timed_out") {
			updates["stage"] = "正在取回结果"
			task.Stage = "正在取回结果"
		} else if task.Status == model.TaskStatusFailed {
			updates["next_poll_at"] = time.Now()
		} else {
			return ErrTaskNotRetryable
		}
		if err := tx.Model(&model.Task{}).Where("id = ? AND user_id = ? AND route_run = ?", task.ID, userID, task.RouteRun).Updates(updates).Error; err != nil {
			return err
		}
		if err := saveRetryAdmission(tx, userID, operationID, payloadHash, "free_recovery", expected.RouteRun, &task); err != nil {
			return err
		}
		accepted = true
		return nil
	})
	if errors.Is(err, errRetryOperationReplayed) {
		return &task, false, nil
	}
	return &task, accepted && err == nil, err
}
