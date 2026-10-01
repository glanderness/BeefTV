package repository

import (
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var ErrProjectRevisionConflict = errors.New("project revision changed")

var ErrProjectArchived = errors.New("project is archived")

func (r *Repository) CreateProjectWithWorkflow(project *model.Project, instance *model.WorkflowInstance, steps []model.WorkflowStepInstance) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(project).Error; err != nil {
			return err
		}
		if instance == nil {
			return nil
		}
		if err := tx.Create(instance).Error; err != nil {
			return err
		}
		if len(steps) > 0 {
			if err := tx.Create(&steps).Error; err != nil {
				return err
			}
		}
		now := time.Now()
		if err := bumpProjectRevisionTx(tx, project.ID, now); err != nil {
			return err
		}
		project.Revision++
		project.UpdatedAt = now
		return nil
	})
}

func (r *Repository) CreateProjectFolderChecked(folder *model.ProjectFolder) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		parentID := strings.TrimSpace(folder.ParentID)
		folder.ParentID = parentID
		if parentID != "" {
			var parent model.ProjectFolder
			if err := tx.First(&parent, "id = ? AND user_id = ?", parentID, folder.UserID).Error; err != nil {
				return err
			}
		}
		return tx.Create(folder).Error
	})
}

func (r *Repository) MoveProjectAndBump(userID, projectID, folderID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		current, err := ownedProjectTx(tx, userID, projectID)
		if err != nil {
			return err
		}
		now := time.Now()
		result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ?", projectID, userID, current.Revision).Updates(map[string]any{
			"folder_id":  folderID,
			"revision":   current.Revision + 1,
			"updated_at": now,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrProjectRevisionConflict
		}
		return nil
	})
}

func (r *Repository) UpdateProjectCAS(userID string, expectedRevision int64, project *model.Project) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		current, err := ownedProjectTx(tx, userID, project.ID)
		if err != nil {
			return err
		}
		if current.Revision != expectedRevision {
			return ErrProjectRevisionConflict
		}
		result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ?", project.ID, userID, expectedRevision).Updates(map[string]any{
			"name": project.Name, "type": project.Type, "aspect_ratio": project.AspectRatio, "source_type": project.SourceType,
			"description": project.Description, "cover_resource_id": project.CoverResourceID,
			"style_preset_id": project.StylePresetID, "style_profile_json": project.StyleProfileJSON,
			"default_image_model": project.DefaultImageModel, "default_video_model": project.DefaultVideoModel,
			"status": project.Status, "revision": expectedRevision + 1, "updated_at": project.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrProjectRevisionConflict
		}
		return nil
	})
}

func (r *Repository) CreateProjectUnitAndBump(userID, projectID string, unit *model.ProjectUnit) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.Create(unit).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) LinkCanvasUnitAtomic(userID, projectID string, canvasRevision int64, payloadJSON string, now time.Time, link *model.CanvasUnitLink) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var canvas model.CanvasProject
		if err := tx.First(&canvas, "id = ? AND user_id = ?", link.CanvasID, userID).Error; err != nil {
			return err
		}
		if canvas.Revision != canvasRevision {
			return ErrCanvasRevisionConflict
		}
		var unit model.ProjectUnit
		if err := tx.First(&unit, "id = ? AND project_id = ?", link.UnitID, projectID).Error; err != nil {
			return err
		}
		oldProjectID := strings.TrimSpace(canvas.ProjectID)
		if oldProjectID != "" && oldProjectID != projectID {
			if err := tx.Where("project_id = ? AND canvas_id = ?", oldProjectID, canvas.ID).Delete(&model.CanvasUnitLink{}).Error; err != nil {
				return err
			}
			var oldProject model.Project
			if err := tx.First(&oldProject, "id = ?", oldProjectID).Error; err == nil {
				if err := bumpProjectRevisionTx(tx, oldProjectID, now); err != nil {
					return err
				}
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		result := tx.Model(&model.CanvasProject{}).
			Where("id = ? AND user_id = ? AND revision = ?", canvas.ID, userID, canvasRevision).
			Updates(map[string]any{
				"project_id":   projectID,
				"payload_json": payloadJSON,
				"updated_at":   now,
				"revision":     canvasRevision + 1,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasRevisionConflict
		}
		if err := upsertCanvasUnitLinkTx(tx, link); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, now)
	})
}

func ownedProjectTx(tx *gorm.DB, userID, projectID string) (*model.Project, error) {
	var project model.Project
	if err := tx.First(&project, "id = ? AND user_id = ?", projectID, userID).Error; err != nil {
		return nil, err
	}
	return &project, nil
}

func requireActiveProjectTx(tx *gorm.DB, userID, projectID string) (*model.Project, error) {
	project, err := ownedProjectTx(tx, userID, projectID)
	if err != nil {
		return nil, err
	}
	if project.Status == model.ProjectStatusArchived {
		return nil, ErrProjectArchived
	}
	return project, nil
}

func bumpProjectRevisionTx(tx *gorm.DB, projectID string, now time.Time) error {
	result := tx.Model(&model.Project{}).Where("id = ?", projectID).Updates(map[string]any{
		"revision":   gorm.Expr("revision + 1"),
		"updated_at": now,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func upsertCanvasUnitLinkTx(tx *gorm.DB, link *model.CanvasUnitLink) error {
	result := tx.Model(&model.CanvasUnitLink{}).Where("project_id = ? AND canvas_id = ? AND unit_id = ?", link.ProjectID, link.CanvasID, link.UnitID).Updates(map[string]any{"role": link.Role})
	if result.Error != nil || result.RowsAffected > 0 {
		return result.Error
	}
	return tx.Create(link).Error
}
