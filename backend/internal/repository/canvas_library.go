package repository

import (
	"errors"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) CanvasLibraryFolders(userID string) ([]model.CanvasLibraryFolder, error) {
	var folders []model.CanvasLibraryFolder
	err := r.db.Where("user_id = ?", userID).Order("updated_at desc, created_at desc").Find(&folders).Error
	return folders, err
}

func (r *Repository) CanvasLibraryFolderForUser(userID, id string) (*model.CanvasLibraryFolder, error) {
	var folder model.CanvasLibraryFolder
	if err := r.db.First(&folder, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &folder, nil
}

func (r *Repository) UpsertCanvasLibraryFolder(folder *model.CanvasLibraryFolder) error {
	existing, err := r.CanvasLibraryFolderForUser(folder.UserID, folder.ID)
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		return r.db.Create(folder).Error
	}
	result := r.db.Model(&model.CanvasLibraryFolder{}).Where("id = ? AND user_id = ?", folder.ID, folder.UserID).Updates(map[string]any{
		"name": folder.Name, "cover_resource_id": folder.CoverResourceID, "updated_at": folder.UpdatedAt,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	folder.CreatedAt = existing.CreatedAt
	return nil
}

func (r *Repository) DeleteCanvasLibraryFolder(userID, id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var folder model.CanvasLibraryFolder
		if err := tx.First(&folder, "id = ? AND user_id = ?", id, userID).Error; err != nil {
			return err
		}
		if tx.Migrator().HasColumn(&model.CanvasProject{}, "library_folder_id") {
			if err := tx.Model(&model.CanvasProject{}).Where("user_id = ? AND library_folder_id = ?", userID, id).
				Updates(map[string]any{"library_folder_id": ""}).Error; err != nil {
				return err
			}
		}
		result := tx.Delete(&model.CanvasLibraryFolder{}, "id = ? AND user_id = ?", id, userID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

func (r *Repository) CanvasDrawings(userID, canvasID string) ([]model.CanvasDrawing, error) {
	var drawings []model.CanvasDrawing
	err := r.db.Select(
		"user_id", "canvas_id", "drawing_id", "engine", "revision", "shape_count", "page_count",
		"preview_resource_id", "render_resource_id", "render_page_id", "render_width", "render_height",
		"render_mime_type", "render_background", "render_storage_key", "created_at", "updated_at",
	).Where("user_id = ? AND canvas_id = ?", userID, canvasID).Order("updated_at desc, drawing_id").Find(&drawings).Error
	return drawings, err
}

func (r *Repository) CanvasDrawingForUser(userID, canvasID, drawingID string) (*model.CanvasDrawing, error) {
	var drawing model.CanvasDrawing
	if err := r.db.First(&drawing, "user_id = ? AND canvas_id = ? AND drawing_id = ?", userID, canvasID, drawingID).Error; err != nil {
		return nil, err
	}
	return &drawing, nil
}

func (r *Repository) UpsertCanvasDrawing(drawing *model.CanvasDrawing) error {
	expected := drawing.Revision
	if expected < 0 {
		return ErrCanvasRevisionConflict
	}
	if expected == 0 {
		created := *drawing
		created.Revision = 1
		result := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&created)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasRevisionConflict
		}
		drawing.Revision = 1
		return nil
	}
	result := r.db.Model(&model.CanvasDrawing{}).
		Where("user_id = ? AND canvas_id = ? AND drawing_id = ? AND revision = ?", drawing.UserID, drawing.CanvasID, drawing.DrawingID, expected).
		Updates(map[string]any{
			"engine": drawing.Engine, "snapshot_json": drawing.SnapshotJSON,
			"shape_count": drawing.ShapeCount, "page_count": drawing.PageCount,
			"preview_resource_id": drawing.PreviewResourceID, "render_resource_id": drawing.RenderResourceID,
			"render_page_id": drawing.RenderPageID, "render_width": drawing.RenderWidth, "render_height": drawing.RenderHeight,
			"render_mime_type": drawing.RenderMimeType, "render_background": drawing.RenderBackground,
			"render_storage_key": drawing.RenderStorageKey, "updated_at": drawing.UpdatedAt, "revision": expected + 1,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCanvasRevisionConflict
	}
	drawing.Revision = expected + 1
	return nil
}

func (r *Repository) DeleteCanvasDrawing(userID, canvasID, drawingID string) error {
	result := r.db.Delete(&model.CanvasDrawing{}, "user_id = ? AND canvas_id = ? AND drawing_id = ?", userID, canvasID, drawingID)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
