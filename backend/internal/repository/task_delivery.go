package repository

import (
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
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, item := range items {
			if item.Asset != nil {
				if err := upsertByID(tx, item.Asset, []string{"folder_id", "kind", "category", "status", "primary_version_id", "title", "payload_json", "updated_at"}); err != nil {
					return err
				}
			}
			if item.Version != nil {
				if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}}, DoNothing: true}).Create(item.Version).Error; err != nil {
					return err
				}
			}
			if item.Representation != nil {
				if err := upsertByID(tx, item.Representation, []string{"task_id", "asset_version_id", "resource_id", "media_type", "role", "metadata_json"}); err != nil {
					return err
				}
			}
			if err := upsertByID(tx, &item.Result, []string{"user_id", "task_id", "kind", "url", "payload"}); err != nil {
				return err
			}
		}
		return nil
	})
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

func upsertByID(tx *gorm.DB, value any, assignments []string) error {
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns(assignments),
	}).Create(value).Error
}
