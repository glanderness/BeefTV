package repository

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm/clause"
)

func isMissingTaskEffectsTable(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "no such table")
}

func (r *Repository) UpsertTaskEffect(effect model.TaskEffect) error {
	if r == nil || r.db == nil || strings.TrimSpace(effect.TaskID) == "" || strings.TrimSpace(effect.Kind) == "" {
		return nil
	}
	now := time.Now()
	if strings.TrimSpace(effect.ID) == "" {
		effect.ID = kernel.NewID()
	}
	if effect.NextAttemptAt.IsZero() {
		effect.NextAttemptAt = now
	}
	if effect.CreatedAt.IsZero() {
		effect.CreatedAt = now
	}
	effect.UpdatedAt = now
	err := r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "task_id"},
			{Name: "kind"},
			{Name: "node_id"},
			{Name: "output_index"},
			{Name: "conversation_id"},
			{Name: "message_id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{
			"canvas_id", "status", "reason", "refused_revision", "attempts", "next_attempt_at", "last_error", "updated_at",
		}),
	}).Create(&effect).Error
	if isMissingTaskEffectsTable(err) {
		return nil
	}
	return err
}

func (r *Repository) MarkTaskEffectSettled(userID, taskID, kind, canvasID, nodeID string, outputIndex int, conversationID, messageID string) error {
	return r.UpsertTaskEffect(model.TaskEffect{
		UserID:         strings.TrimSpace(userID),
		TaskID:         strings.TrimSpace(taskID),
		Kind:           strings.TrimSpace(kind),
		CanvasID:       strings.TrimSpace(canvasID),
		NodeID:         strings.TrimSpace(nodeID),
		OutputIndex:    outputIndex,
		ConversationID: strings.TrimSpace(conversationID),
		MessageID:      strings.TrimSpace(messageID),
		Status:         model.TaskEffectStatusSettled,
		Reason:         "",
	})
}

func (r *Repository) MarkTaskEffectRefused(userID, taskID, kind, canvasID, nodeID string, outputIndex int, reason string, refusedRevision int64) error {
	return r.UpsertTaskEffect(model.TaskEffect{
		UserID:          strings.TrimSpace(userID),
		TaskID:          strings.TrimSpace(taskID),
		Kind:            strings.TrimSpace(kind),
		CanvasID:        strings.TrimSpace(canvasID),
		NodeID:          strings.TrimSpace(nodeID),
		OutputIndex:     outputIndex,
		Status:          model.TaskEffectStatusRefused,
		Reason:          strings.TrimSpace(reason),
		RefusedRevision: refusedRevision,
	})
}

func (r *Repository) ClearTaskEffectsByKind(taskID, kind string) error {
	if r == nil || r.db == nil || strings.TrimSpace(taskID) == "" || strings.TrimSpace(kind) == "" {
		return nil
	}
	err := r.db.Where("task_id = ? AND kind = ?", strings.TrimSpace(taskID), strings.TrimSpace(kind)).Delete(&model.TaskEffect{}).Error
	if isMissingTaskEffectsTable(err) {
		return nil
	}
	return err
}

func (r *Repository) IsTaskEffectSettled(taskID, kind, nodeID string, outputIndex int, conversationID, messageID string) (bool, error) {
	if r == nil || r.db == nil || strings.TrimSpace(taskID) == "" || strings.TrimSpace(kind) == "" {
		return false, nil
	}
	var count int64
	err := r.db.Model(&model.TaskEffect{}).
		Where("task_id = ? AND kind = ? AND node_id = ? AND output_index = ? AND conversation_id = ? AND message_id = ? AND status = ?",
			strings.TrimSpace(taskID),
			strings.TrimSpace(kind),
			strings.TrimSpace(nodeID),
			outputIndex,
			strings.TrimSpace(conversationID),
			strings.TrimSpace(messageID),
			model.TaskEffectStatusSettled,
		).Count(&count).Error
	if isMissingTaskEffectsTable(err) {
		return false, nil
	}
	return count > 0, err
}

// PendingDeliveryTasks returns one keyset page of succeeded tasks whose
// generation delivery has not yet been durably marked settled in task_effects.
func (r *Repository) PendingDeliveryTasks(afterID string, limit int) ([]model.Task, error) {
	if limit <= 0 {
		limit = 64
	}
	query := r.db.Where(
		`status = ? AND result_json <> '' AND NOT EXISTS (
			SELECT 1 FROM task_effects te
			WHERE te.task_id = tasks.id AND te.kind = ? AND te.status = ?
		)`,
		model.TaskStatusSucceeded,
		model.TaskEffectKindDeliverySettled,
		model.TaskEffectStatusSettled,
	)
	if afterID != "" {
		query = query.Where("id > ?", afterID)
	}
	var tasks []model.Task
	err := query.Order("id asc").Limit(limit).Find(&tasks).Error
	if isMissingTaskEffectsTable(err) {
		return r.SucceededTasksForDelivery(afterID, limit)
	}
	return tasks, err
}

// PendingCanvasBindTasks returns one keyset page of succeeded tasks that still
// need post-completion binding/registration work, excluding:
//  1. tasks already durably settled (`task_bind_settled`),
//  2. tasks waiting solely on a missing canvas that still does not exist, and
//  3. tasks waiting solely on refused targets whose canvas revision has not moved.
func (r *Repository) PendingCanvasBindTasks(afterID string, limit int) ([]model.Task, error) {
	if limit <= 0 {
		limit = 64
	}
	query := r.db.Where(
		`status = ? AND result_json <> ''
		AND NOT EXISTS (
			SELECT 1 FROM task_effects te
			WHERE te.task_id = tasks.id AND te.kind = ? AND te.status = ?
		)
		AND NOT (
			EXISTS (
				SELECT 1 FROM task_effects te
				WHERE te.task_id = tasks.id AND te.kind = ? AND te.status = ?
			)
			AND NOT EXISTS (
				SELECT 1 FROM task_effects te
				JOIN canvas_projects cp ON cp.user_id = tasks.user_id AND cp.id = te.canvas_id
				WHERE te.task_id = tasks.id AND te.kind = ? AND te.status = ?
			)
		)
		AND NOT (
			EXISTS (
				SELECT 1 FROM task_effects te
				WHERE te.task_id = tasks.id AND te.kind = ? AND te.status = ?
			)
			AND NOT EXISTS (
				SELECT 1 FROM task_effects te
				WHERE te.task_id = tasks.id AND te.kind = ? AND te.status = ?
				AND (
					(te.reason IN ('node_deleted', 'node_task_mismatch') AND te.refused_revision > 0 AND EXISTS (
						SELECT 1 FROM canvas_projects cp
						WHERE cp.user_id = tasks.user_id AND cp.id = te.canvas_id AND cp.revision > te.refused_revision
					))
					OR (te.reason NOT IN ('node_deleted', 'node_task_mismatch', 'node_mismatch', 'canvas_mismatch'))
				)
			)
		)`,
		model.TaskStatusSucceeded,
		model.TaskEffectKindTaskBindSettled, model.TaskEffectStatusSettled,
		model.TaskEffectKindCanvasMissing, model.TaskEffectStatusPending,
		model.TaskEffectKindCanvasMissing, model.TaskEffectStatusPending,
		model.TaskEffectKindCanvasBind, model.TaskEffectStatusRefused,
		model.TaskEffectKindCanvasBind, model.TaskEffectStatusRefused,
	)
	if afterID != "" {
		query = query.Where("id > ?", afterID)
	}
	var tasks []model.Task
	err := query.Order("id asc").Limit(limit).Find(&tasks).Error
	if isMissingTaskEffectsTable(err) {
		return r.SucceededTasksForDelivery(afterID, limit)
	}
	return tasks, err
}
