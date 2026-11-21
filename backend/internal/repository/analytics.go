package repository

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func (r *Repository) LatestProviderRequestIDForTask(taskID string) (string, error) {
	var log model.ApiCallLog
	err := r.db.Select("provider_request_id").
		Where("task_id = ? AND provider_request_id <> '' AND NOT (status = ? AND (request_kind = '' OR request_kind = 'create'))", taskID, model.ApiCallStatusFailed).
		Order("created_at desc").
		First(&log).Error
	return strings.TrimSpace(log.ProviderRequestID), err
}

func (r *Repository) HasAPICallLogForTask(taskID string) (bool, error) {
	if strings.TrimSpace(taskID) == "" {
		return false, nil
	}
	var count int64
	err := r.db.Model(&model.ApiCallLog{}).Where("task_id = ?", taskID).Count(&count).Error
	return count > 0, err
}

var ErrAmbiguousImageCreateReceipts = errors.New("图片包含多条已接受或结果未知的创建回执，不能重新生成")

// Recovery requires one unambiguous create receipt. A later failed/unknown
// create must never be hidden by selecting an earlier successful response.
func (r *Repository) ImageCreateReceipt(userID, taskID string) (*model.ApiCallLog, error) {
	query := r.db.Model(&model.ApiCallLog{}).Where("user_id = ? AND task_id = ? AND capability = ? AND request_kind = ? AND method = ?", userID, taskID, "image", "create", "POST")
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return nil, err
	}
	if count > 1 {
		var uncertain int64
		if err := query.Where("status_code IS NULL OR status_code = 0 OR (status_code >= 200 AND status_code < 300)").Count(&uncertain).Error; err != nil {
			return nil, err
		}
		if uncertain > 0 {
			return nil, ErrAmbiguousImageCreateReceipts
		}
		return nil, nil
	}
	var rows []model.ApiCallLog
	err := r.db.Where("user_id = ? AND task_id = ? AND capability = ? AND request_kind = ? AND method = ?", userID, taskID, "image", "create", "POST").Order("created_at desc").Limit(2).Find(&rows).Error
	if err != nil || len(rows) != 1 {
		return nil, err
	}
	return &rows[0], nil
}

func (r *Repository) VideoAPICallRoot(log model.ApiCallLog) (*model.ApiCallLog, error) {
	var root model.ApiCallLog
	query := r.db.Where("capability = ? AND request_kind = ?", "video", "create")
	if log.TaskID != "" {
		query = query.Where("task_id = ?", log.TaskID)
	} else {
		query = query.Where("user_id = ? AND channel_id = ? AND provider_request_id = ?", log.UserID, log.ChannelID, log.ProviderRequestID)
	}
	if err := query.Order("created_at desc").First(&root).Error; err != nil {
		return nil, err
	}
	return &root, nil
}
