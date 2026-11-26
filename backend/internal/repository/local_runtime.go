package repository

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var (
	ErrActiveTaskLimit  = errors.New("active task limit reached")
	ErrTaskNotRetryable = errors.New("task is not retryable")
)

func (r *Repository) ChannelModels(channelID string, includeDisabled bool) ([]model.ChannelModel, error) {
	var items []model.ChannelModel
	query := r.db.Where("channel_id = ?", channelID).Order("sort_order asc, created_at asc, id asc")
	if !includeDisabled {
		query = query.Where("enabled = ?", true)
	}
	if err := query.Find(&items).Error; err != nil {
		return nil, err
	}
	return items, r.attachChannelModelVariants(items)
}

func (r *Repository) ChannelModelByID(channelID, id string) (*model.ChannelModel, error) {
	var item model.ChannelModel
	if err := r.db.First(&item, "id = ? AND channel_id = ?", id, channelID).Error; err != nil {
		return nil, err
	}
	items := []model.ChannelModel{item}
	if err := r.attachChannelModelVariants(items); err != nil {
		return nil, err
	}
	return &items[0], nil
}

func (r *Repository) ChannelModelByKey(channelID, modelKey string) (*model.ChannelModel, error) {
	var item model.ChannelModel
	if err := r.db.Where("channel_id = ? AND model_key = ? AND enabled = ?", channelID, modelKey, true).First(&item).Error; err != nil {
		return nil, err
	}
	items := []model.ChannelModel{item}
	if err := r.attachChannelModelVariants(items); err != nil {
		return nil, err
	}
	return &items[0], nil
}

func (r *Repository) attachChannelModelVariants(items []model.ChannelModel) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, len(items))
	for index := range items {
		ids[index] = items[index].ID
	}
	var tiers []model.ChannelModelVariant
	if r.db.Migrator().HasTable(&model.ChannelModelVariant{}) {
		if err := r.db.Where("channel_model_id IN ?", ids).Order("selector_key asc, created_at asc").Find(&tiers).Error; err != nil {
			return err
		}
	}
	byModel := make(map[string][]model.ChannelModelVariant)
	for index := range tiers {
		tiers[index].Selector = model.DecodeSKUSelector(tiers[index].SelectorJSON)
		byModel[tiers[index].ChannelModelID] = append(byModel[tiers[index].ChannelModelID], tiers[index])
	}
	for index := range items {
		items[index].Variants = byModel[items[index].ID]
	}
	return nil
}

func (r *Repository) PopulateChannelModelVariants(items []model.ChannelModel) error {
	return r.attachChannelModelVariants(items)
}
func (r *Repository) PopulateChannelModelVariant(item *model.ChannelModel) error {
	if item == nil {
		return nil
	}
	items := []model.ChannelModel{*item}
	if err := r.attachChannelModelVariants(items); err != nil {
		return err
	}
	*item = items[0]
	return nil
}

// ClientOperationReplay 表示这个确认已经有任务。调用方应回读 Task，不能再插入一条。
type ClientOperationReplay struct {
	Task model.Task
}

func (e *ClientOperationReplay) Error() string { return "client operation replay" }

func (r *Repository) TaskByClientOperation(userID, key string) (*model.Task, error) {
	var task model.Task
	err := r.db.Where("user_id = ? AND client_operation_id = ?", userID, key).First(&task).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &task, nil
}

func (r *Repository) CreateTaskWithActiveLimit(task *model.Task, limit int) error {
	return withImmediateTransaction(r.db, func(tx *gorm.DB) error {
		if task.ClientOperationID != nil && strings.TrimSpace(*task.ClientOperationID) != "" {
			var existing model.Task
			err := tx.Where("user_id = ? AND client_operation_id = ?", task.UserID, *task.ClientOperationID).First(&existing).Error
			if err == nil {
				return &ClientOperationReplay{Task: existing}
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		if err := r.requireActiveLogicalModelForTask(tx, task); err != nil {
			return err
		}
		if err := RequireTaskScopeActiveTx(tx, task.UserID, task.ProjectID); err != nil {
			return err
		}
		ids, err := taskInputResourceIDs(task.InputJSON)
		if err != nil {
			return err
		}
		if err := RequireReadyOwnedResourcesTx(tx, task.UserID, ids); err != nil {
			return err
		}
		if err := enforceActiveTaskLimit(tx, task.UserID, limit); err != nil {
			return err
		}
		if err := tx.Create(task).Error; err != nil {
			if task.ClientOperationID != nil && isUniqueConstraint(err) {
				var existing model.Task
				if findErr := tx.Where("user_id = ? AND client_operation_id = ?", task.UserID, *task.ClientOperationID).First(&existing).Error; findErr == nil {
					return &ClientOperationReplay{Task: existing}
				}
			}
			return err
		}
		return nil
	})
}

func (r *Repository) RetryTask(userID string, prepared *model.Task, limit int) (*model.Task, error) {
	return r.retryTask(userID, prepared, limit, nil)
}

func (r *Repository) RetryTaskWithExpectedInput(userID string, prepared *model.Task, limit int, expectedInputJSON string) (*model.Task, error) {
	return r.retryTask(userID, prepared, limit, &expectedInputJSON)
}

func (r *Repository) retryTask(userID string, prepared *model.Task, limit int, expectedInputJSON *string) (*model.Task, error) {
	var task model.Task
	err := withImmediateTransaction(r.db, func(tx *gorm.DB) error {
		if err := RequireTaskScopeActiveTx(tx, userID, prepared.ProjectID); err != nil {
			return err
		}
		ids, err := taskInputResourceIDs(prepared.InputJSON)
		if err != nil {
			return err
		}
		if err := RequireReadyOwnedResourcesTx(tx, userID, ids); err != nil {
			return err
		}
		if err := enforceActiveTaskLimit(tx, userID, limit); err != nil {
			return err
		}
		updates := map[string]any{
			"status": model.TaskStatusQueued, "stage": "等待队列调度", "progress": 5, "error": "", "error_code": "", "failure_diagnostics": nil, "recovery_outcome": nil, "beef_usage_state": nil, "beef_billing_state": nil, "beef_reconcile_deadline": nil, "image_job_id": "", "result_json": "", "text_draft": "", "started_at": nil, "completed_at": nil,
			"provider_request_id": "", "poll_stage": "", "next_poll_at": nil, "provider_cancel_status": "", "provider_cancel_error": "", "provider_cancel_attempts": 0,
			"provider_cancel_requested_at": nil, "provider_cancelled_at": nil, "provider_cancel_next_check_at": nil, "route_run": gorm.Expr("route_run + ?", 1),
			"logical_model_revision_id": prepared.LogicalModelRevisionID, "route_id": prepared.RouteID, "channel_model_id": prepared.ChannelModelID, "input_json": prepared.InputJSON,
			"model": prepared.Model, "provider": prepared.Provider, "lease_owner": "", "lease_expires_at": nil, "updated_at": time.Now(),
		}
		query := tx.Model(&model.Task{}).Where("id = ? AND user_id = ? AND status IN ?", prepared.ID, userID, []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled})
		if expectedInputJSON != nil {
			query = query.Where("input_json = ? AND provider_request_id = ? AND poll_stage = ? AND next_poll_at IS NULL", *expectedInputJSON, "", "")
		}
		updated := query.Updates(updates)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrTaskNotRetryable
		}
		if err := tx.Delete(&model.TaskTextDelta{}, "user_id = ? AND task_id = ?", userID, prepared.ID).Error; err != nil {
			return err
		}
		return tx.First(&task, "id = ? AND user_id = ?", prepared.ID, userID).Error
	})
	return &task, err
}

func taskInputResourceIDs(inputJSON string) ([]string, error) {
	found := map[string]struct{}{}
	raw := strings.TrimSpace(inputJSON)
	if raw == "" {
		return nil, nil
	}
	if err := assets.CollectOwnedDocumentReferences(raw, found); err != nil {
		if id := assets.ResourceID(raw); id != "" {
			return []string{id}, nil
		}
		return nil, ErrTaskInputInvalid
	}
	return assets.SortedIDs(found), nil
}

func enforceActiveTaskLimit(tx *gorm.DB, userID string, limit int) error {
	var count int64
	if err := tx.Model(&model.Task{}).Where("user_id = ? AND status IN ?", userID, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Count(&count).Error; err != nil {
		return err
	}
	if count >= int64(limit) {
		return ErrActiveTaskLimit
	}
	return nil
}

func isUniqueConstraint(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	return strings.Contains(strings.ToUpper(err.Error()), "UNIQUE CONSTRAINT FAILED")
}

func newRepositoryID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(value[:])
}
