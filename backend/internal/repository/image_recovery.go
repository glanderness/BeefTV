package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// 读投影只取小字段；完整冻结请求由恢复路径按原任务、用户和 attempt 单独读取。
type ImageSubmissionEvidence struct {
	AttemptID        string
	TaskID           string
	UserID           string
	ResponseAccepted bool
}

type ImageRecoveryEvidence struct {
	Attempt    *model.RouteAttempt
	Submission *ImageSubmissionEvidence
	HasReceipt bool
}

// LatestBeefAPIImageJobIDForTask returns only the formal gateway's asynchronous
// image identity. Third-party logs must never make an image retry look safely
// retrievable through the managed-channel endpoint.
func (r *Repository) LatestBeefAPIImageJobIDForTask(taskID, userID string) (string, error) {
	var row struct {
		ImageJobID string
	}
	query := r.db.Model(&model.ApiCallLog{}).
		Select("image_job_id").
		Where("task_id = ? AND user_id = ? AND source = ? AND capability = ? AND request_kind = ? AND method = ? AND image_job_id <> ?", taskID, userID, "beefapi", "image", "create", "POST", "")
	if err := query.Order("created_at DESC, id DESC").First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", nil
		}
		return "", err
	}
	return row.ImageJobID, nil
}

// 固定次数批量读取，不为列表中的每个任务逐一查库。
func (r *Repository) ImageRecoveryEvidence(taskIDs []string) (map[string]ImageRecoveryEvidence, error) {
	facts := make(map[string]ImageRecoveryEvidence, len(taskIDs))
	if len(taskIDs) == 0 {
		return facts, nil
	}
	var attempts []model.RouteAttempt
	if err := r.db.Select("id", "task_id", "route_run", "channel_id", "dispatch_state", "started_at").Where("task_id IN ?", taskIDs).
		Where(`id = (SELECT ra.id FROM route_attempts ra WHERE ra.task_id = route_attempts.task_id ORDER BY ra.route_run DESC, ra.attempt_number DESC, ra.id ASC LIMIT 1)`).Find(&attempts).Error; err != nil {
		return nil, err
	}
	attemptIDs := make([]string, 0, len(attempts))
	for i := range attempts {
		a := &attempts[i]
		facts[a.TaskID] = ImageRecoveryEvidence{Attempt: a}
		attemptIDs = append(attemptIDs, a.ID)
	}
	if len(attemptIDs) > 0 {
		var submissions []ImageSubmissionEvidence
		if err := r.db.Model(&model.ImageSubmission{}).Select("attempt_id", "task_id", "user_id", "response_accepted").
			Where("attempt_id IN ? AND task_id IN ?", attemptIDs, taskIDs).Find(&submissions).Error; err != nil {
			return nil, err
		}
		for i := range submissions {
			row := &submissions[i]
			f := facts[row.TaskID]
			if f.Attempt != nil && f.Attempt.ID == row.AttemptID {
				f.Submission = row
				facts[row.TaskID] = f
			}
		}
	}
	var receipts []struct{ TaskID string }
	if err := r.db.Model(&model.ApiCallLog{}).Select("api_call_logs.task_id").
		Joins("JOIN tasks ON tasks.id = api_call_logs.task_id AND tasks.user_id = api_call_logs.user_id").
		Where("tasks.id IN ? AND capability = ? AND request_kind = ? AND method = ?", taskIDs, "image", "create", "POST").Group("api_call_logs.task_id").Scan(&receipts).Error; err != nil {
		return nil, err
	}
	for _, row := range receipts {
		f := facts[row.TaskID]
		f.HasReceipt = true
		facts[row.TaskID] = f
	}
	return facts, nil
}

func (r *Repository) FailedImagesForRecovery(afterID string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	err := r.db.Where("tasks.id > ? AND tasks.type = ? AND tasks.status = ?", afterID, "canvas_image", model.TaskStatusFailed).
		Where("(recovery_outcome IS NULL OR recovery_outcome = '') AND (next_poll_at IS NULL OR next_poll_at <= ?)", time.Now()).
		Where(`stage = 'submission_unknown' OR EXISTS (SELECT 1 FROM api_call_logs l WHERE l.task_id = tasks.id AND l.user_id = tasks.user_id AND l.capability = 'image' AND l.request_kind = 'create' AND l.method = 'POST') OR (SELECT a.dispatch_state FROM route_attempts a WHERE a.task_id = tasks.id AND a.route_run = tasks.route_run ORDER BY a.attempt_number DESC, a.id ASC LIMIT 1) IN ('accepted', 'submission_unknown')`).
		Order("tasks.id ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// 不改变 status/route_run；后台恢复不是重新排队，也不会进入创建任务执行器。
func (r *Repository) FinishFailedImageRecovery(task model.Task, outcome *string, nextPollAt *time.Time) error {
	result := taskLeaseWriter(r.db.Model(&model.Task{}), task.LeaseOwner).
		Where("id = ? AND user_id = ? AND status = ? AND route_run = ?", task.ID, task.UserID, model.TaskStatusFailed, task.RouteRun).
		Updates(map[string]any{"recovery_outcome": outcome, "next_poll_at": nextPollAt, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

// 仅持有失败任务恢复租约的同键重放可以跳过旧 worker 的 12 次限制。
func imageSubmissionTaskWriter(tx *gorm.DB, row *model.ImageSubmission, owner string, maxSends int) *gorm.DB {
	query := taskLeaseWriter(tx.Model(&model.Task{}), owner).Where("id = ? AND user_id = ?", row.TaskID, row.UserID)
	if maxSends > 0 {
		return query.Where("status = ?", model.TaskStatusRunning)
	}
	return query.Where("status = ? AND lease_owner LIKE ? AND (recovery_outcome IS NULL OR recovery_outcome = '')", model.TaskStatusFailed, "manual-recovery:%").
		Where("EXISTS (SELECT 1 FROM route_attempts a WHERE a.id = ? AND a.task_id = tasks.id AND a.route_run = tasks.route_run AND a.dispatch_state IN ?)", row.AttemptID, []string{"accepted", "submission_unknown"})
}
