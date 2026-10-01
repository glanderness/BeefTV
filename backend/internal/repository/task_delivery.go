package repository

import (
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const generationOutputResultKind = "generation_output"

type GenerationDeliveryItem struct {
	Result         model.Result
	Asset          *model.Asset
	Version        *model.AssetVersion
	Representation *model.AssetRepresentation
}

func (r *Repository) UpsertGenerationDelivery(items []GenerationDeliveryItem) error {
	if len(items) == 0 {
		return nil
	}
	return r.Transaction(func(tx *Repository) error {
		for _, item := range items {
			if err := tx.CommitOwnedGenerationDelivery(item); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) CommitOwnedGenerationDelivery(item GenerationDeliveryItem) error {
	if item.Asset != nil {
		if err := insertOwnedAsset(r.db, item.Asset); err != nil {
			return err
		}
	}
	if item.Version != nil {
		if err := insertIgnoringConflict(r.db, item.Version); err != nil {
			return err
		}
	}
	if item.Representation != nil {
		if err := insertIgnoringConflict(r.db, item.Representation); err != nil {
			return err
		}
	}
	return upsertByID(r.db, &item.Result, []string{"user_id", "task_id", "kind", "url", "payload"})
}

func (r *Repository) GenerationOutputResults(taskID string) ([]model.Result, error) {
	var results []model.Result
	err := r.db.Where("task_id = ? AND kind = ?", taskID, generationOutputResultKind).Order("id asc").Find(&results).Error
	return results, err
}

func (r *Repository) GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error) {
	if len(taskIDs) == 0 {
		return nil, nil
	}
	var results []model.Result
	err := r.db.Where("task_id IN ? AND kind = ?", taskIDs, generationOutputResultKind).Order("task_id asc, id asc").Find(&results).Error
	return results, err
}

func (r *Repository) SucceededTasksForDelivery(limit int) ([]model.Task, error) {
	if limit <= 0 {
		limit = 64
	}
	var tasks []model.Task
	seen := make(map[string]struct{}, limit*3)
	appendUnique := func(batch []model.Task) {
		for _, task := range batch {
			if strings.TrimSpace(task.ID) == "" {
				continue
			}
			if _, ok := seen[task.ID]; ok {
				continue
			}
			seen[task.ID] = struct{}{}
			tasks = append(tasks, task)
		}
	}

	var missing []model.Task
	if err := r.db.Where("status = ? AND result_json <> ''", model.TaskStatusSucceeded).
		Where("NOT EXISTS (SELECT 1 FROM results WHERE results.task_id = tasks.id AND results.kind = ?)", generationOutputResultKind).
		Order("updated_at asc").Limit(limit).Find(&missing).Error; err != nil {
		return nil, err
	}
	appendUnique(missing)

	var retryable []model.Task
	if err := r.db.Where("status = ? AND result_json <> ''", model.TaskStatusSucceeded).
		Where(`EXISTS (SELECT 1 FROM results WHERE results.task_id = tasks.id AND results.kind = ? AND (
			results.payload LIKE ? OR results.payload LIKE ? OR results.payload LIKE ? OR results.payload LIKE ?
		))`, generationOutputResultKind,
			`%"materializationErrorCode":"persist_failed"%`,
			`%"materializationErrorCode":"resource_missing"%`,
			`%"materializationErrorCode":"resource_not_ready"%`,
			`%"materializationErrorCode":"delivery_unreadable"%`,
		).
		Order("updated_at asc").Limit(limit).Find(&retryable).Error; err != nil {
		return nil, err
	}
	appendUnique(retryable)

	if len(tasks) >= limit {
		return tasks, nil
	}

	var recent []model.Task
	if err := r.db.Where("status = ? AND result_json <> ''", model.TaskStatusSucceeded).
		Order("updated_at desc").Limit(limit).Find(&recent).Error; err != nil {
		return nil, err
	}
	appendUnique(recent)
	if len(tasks) > limit {
		return tasks[:limit], nil
	}
	return tasks, nil
}

func insertOwnedAsset(tx *gorm.DB, asset *model.Asset) error {
	if err := tx.Create(asset).Error; err == nil {
		return nil
	} else if !isUniqueConstraint(err) {
		return err
	}
	var existing model.Asset
	if lookupErr := tx.First(&existing, "id = ?", asset.ID).Error; lookupErr != nil {
		return lookupErr
	}
	if existing.UserID != asset.UserID {
		return ErrAssetOwnedByAnotherUser
	}
	return nil
}

func insertIgnoringConflict(tx *gorm.DB, value any) error {
	err := tx.Create(value).Error
	if err == nil || isUniqueConstraint(err) {
		return nil
	}
	return err
}

func upsertByID(tx *gorm.DB, value any, assignments []string) error {
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns(assignments),
	}).Create(value).Error
}
