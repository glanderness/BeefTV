package repository

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

// FailedVideoTasksForRecovery returns recent failed tasks that still retain an
// accepted provider task identity. It only selects task metadata; the recovery
// path loads the encrypted input for the one task it is about to query.
func (r *Repository) FailedVideoTasksForRecovery(afterID string, limit int) ([]model.Task, error) {
	if limit <= 0 {
		limit = 8
	}
	now := time.Now()
	query := r.db.Model(&model.Task{}).
		Select("tasks.id, tasks.user_id, tasks.type, tasks.model, tasks.status, tasks.provider_request_id, tasks.poll_stage, tasks.next_poll_at, tasks.recovery_outcome, tasks.started_at").
		Where("tasks.id > ? AND tasks.status = ?", afterID, model.TaskStatusFailed).
		Where("tasks.provider_request_id <> ''").
		Where("(tasks.recovery_outcome IS NULL OR tasks.recovery_outcome = '')").
		Where("(tasks.next_poll_at IS NULL OR tasks.next_poll_at <= ?)", now).
		Where("(tasks.started_at IS NULL OR tasks.started_at >= ?)", now.Add(-24*time.Hour)).
		Where("(tasks.type LIKE ? OR tasks.type LIKE ? OR tasks.operation = ?)", "canvas_video%", "video_%", "media.upscale.topaz").
		Order("tasks.id ASC").Limit(limit)
	var tasks []model.Task
	if err := query.Find(&tasks).Error; err != nil {
		return nil, err
	}
	return tasks, nil
}
