package repository

import (
	"errors"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var ErrResourceCleanupSetChanged = errors.New("resource cleanup set changed")
var ErrResourceCleanupStillReferenced = errors.New("resource cleanup resource is still directly referenced")
var ErrResourceNotReadyForAdmission = errors.New("resource is not ready for admission")
var ErrTaskInputInvalid = errors.New("task input is invalid")

// DeleteDetachedResources removes Resource rows and enqueues physical deletion in one transaction.
// JSON references are checked by the service before this call; direct foreign-key-like references
// and live task documents (including completed outputs) are checked again under BEGIN IMMEDIATE
// so a newly admitted task cannot lose its material. When a verified single-connection SQLite
// watermark from the preceding ResourceReferenceSnapshot still matches inside BEGIN IMMEDIATE,
// no SQLite writes occurred in between and the redundant full-table re-scan is skipped.
func (r *Repository) DeleteDetachedResources(resources []model.Resource, deletionJobs []model.ResourceDeletionJob, verifiedWatermark ...SQLiteSnapshotWatermark) error {
	if len(resources) == 0 {
		return nil
	}
	var watermark SQLiteSnapshotWatermark
	if len(verifiedWatermark) > 0 {
		watermark = verifiedWatermark[0]
	}
	resourceIDs := make([]string, 0, len(resources))
	for _, resource := range resources {
		resourceIDs = append(resourceIDs, resource.ID)
	}
	return withImmediateTransaction(r.db, func(tx *gorm.DB) error {
		var current []model.Resource
		query := tx.Where("id IN ?", resourceIDs)
		if err := query.Find(&current).Error; err != nil {
			return err
		}
		if len(current) != len(resources) {
			return ErrResourceCleanupSetChanged
		}
		if !watermark.Valid || !r.watermarkMatchesTx(tx, watermark) {
			// Re-verify references atomically under BEGIN IMMEDIATE using
			// canonical prefilter + assets.DocumentReferences so concurrent
			// writes during unlocked snapshot scanning can never lose media.
			idsByUser := map[string][]string{}
			for _, resource := range current {
				idsByUser[resource.UserID] = append(idsByUser[resource.UserID], resource.ID)
			}
			for userID, ids := range idsByUser {
				idSet := make(map[string]struct{}, len(ids))
				for _, id := range ids {
					idSet[id] = struct{}{}
				}
				var assetDocuments []string
				if err := applySQLiteReferenceFilter(
					tx.Model(&model.Asset{}).Where("user_id = ? AND payload_json <> ''", userID),
					"payload_json",
				).Pluck("payload_json", &assetDocuments).Error; err != nil {
					return err
				}
				for _, document := range assetDocuments {
					if assets.DocumentReferences(document, idSet) {
						return ErrResourceCleanupStillReferenced
					}
				}
				var canvasDocuments []string
				if err := tx.Model(&model.CanvasProject{}).Where("user_id = ? AND payload_json <> ''", userID).Pluck("payload_json", &canvasDocuments).Error; err != nil {
					return err
				}
				for _, document := range canvasDocuments {
					if assets.DocumentReferences(document, idSet) {
						return ErrResourceCleanupStillReferenced
					}
				}
			}
			for _, check := range []struct {
				model any
				query string
			}{
				{&model.AssetRepresentation{}, "resource_id IN ?"},
				{&model.VoiceProfile{}, "sample_resource_id IN ?"},
				{&model.ShotArtifact{}, "resource_id IN ?"},
			} {
				var count int64
				if err := tx.Model(check.model).Where(check.query, resourceIDs).Count(&count).Error; err != nil {
					return err
				}
				if count > 0 {
					return ErrResourceCleanupStillReferenced
				}
			}
			if tx.Migrator().HasTable(&model.CanvasSnapshotResource{}) {
				history, err := New(tx).CanvasHistoryResourceReferences(resourceIDs)
				if err != nil {
					return err
				}
				if len(history) > 0 {
					return ErrResourceCleanupStillReferenced
				}
			}
			for userID, ids := range idsByUser {
				if err := guardCanvasLibraryResourceReferences(tx, userID, ids); err != nil {
					return err
				}
				if err := guardCanvasWorkflowResourceReferences(tx, userID, ids); err != nil {
					return err
				}
				exports, err := New(tx).ProjectExportResourceReferences(userID, ids)
				if err != nil {
					return err
				}
				if len(exports) > 0 {
					return ErrResourceCleanupStillReferenced
				}
				if err := guardAdditionalWorkspaceResourceReferences(tx, userID, ids); err != nil {
					return err
				}
				if err := guardTaskResourceReferences(tx, userID, ids, false); err != nil {
					return err
				}
			}
		}
		if err := tx.Where("resource_id IN ?", resourceIDs).Delete(&model.ArkPrivateAssetBinding{}).Error; err != nil {
			return err
		}
		if err := settleDeletedResources(tx, current); err != nil {
			return err
		}
		if len(deletionJobs) > 0 {
			if err := tx.Create(&deletionJobs).Error; err != nil {
				return err
			}
		}
		deleted := tx.Where("id IN ?", resourceIDs).Delete(&model.Resource{})
		if deleted.Error != nil {
			return deleted.Error
		}
		if deleted.RowsAffected != int64(len(resourceIDs)) {
			return ErrResourceCleanupSetChanged
		}
		return nil
	})
}

// guardAdditionalWorkspaceResourceReferences closes the race window for tables
// checked during snapshot scanning when snapshot collection runs outside
// storageMu. Optional tables are checked only when present in the schema.
func guardAdditionalWorkspaceResourceReferences(tx *gorm.DB, userID string, resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	idSet := make(map[string]struct{}, len(resourceIDs))
	for _, id := range resourceIDs {
		idSet[id] = struct{}{}
	}
	if tx.Migrator().HasTable(&model.CreationRun{}) {
		var runs []model.CreationRun
		if err := applySQLiteReferenceFilter(
			tx.Select("state_json", "approved_operations_json").Where("user_id = ? AND (state_json <> '' OR approved_operations_json <> '')", userID),
			"state_json", "approved_operations_json",
		).Find(&runs).Error; err != nil {
			return err
		}
		for _, run := range runs {
			if assets.DocumentReferences(run.StateJSON, idSet) || assets.DocumentReferences(run.ApprovedOperationsJSON, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.CreationSubmission{}) {
		var docs []string
		if err := applySQLiteReferenceFilter(
			tx.Model(&model.CreationSubmission{}).Where("user_id = ? AND revoked_at IS NULL AND request_json <> ''", userID),
			"request_json",
		).Pluck("request_json", &docs).Error; err != nil {
			return err
		}
		for _, doc := range docs {
			if assets.DocumentReferences(doc, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.Project{}) {
		var coverCount int64
		if err := tx.Model(&model.Project{}).Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).Count(&coverCount).Error; err != nil {
			return err
		}
		if coverCount > 0 {
			return ErrResourceCleanupStillReferenced
		}
		var styleDocs []string
		if err := applySQLiteReferenceFilter(
			tx.Model(&model.Project{}).Where("user_id = ? AND style_profile_json <> ''", userID),
			"style_profile_json",
		).Pluck("style_profile_json", &styleDocs).Error; err != nil {
			return err
		}
		for _, doc := range styleDocs {
			if assets.DocumentReferences(doc, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.StyleProfile{}) {
		var styles []model.StyleProfile
		if err := applySQLiteReferenceFilter(
			tx.Select("cover_url", "profile_json").Where("user_id = ? AND (cover_url <> '' OR profile_json <> '')", userID),
			"cover_url", "profile_json",
		).Find(&styles).Error; err != nil {
			return err
		}
		for _, style := range styles {
			if assets.DocumentReferences(style.CoverURL, idSet) || assets.DocumentReferences(style.ProfileJSON, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.AssetVersion{}) {
		var docs []string
		if err := applySQLiteReferenceFilter(
			tx.Table("asset_versions").
				Joins("JOIN assets ON assets.id = asset_versions.asset_id").
				Where("assets.user_id = ? AND asset_versions.definition_json <> ''", userID),
			"asset_versions.definition_json",
		).Pluck("asset_versions.definition_json", &docs).Error; err != nil {
			return err
		}
		for _, doc := range docs {
			if assets.DocumentReferences(doc, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.ProjectAssetCandidate{}) && tx.Migrator().HasTable(&model.Project{}) {
		var docs []string
		if err := applySQLiteReferenceFilter(
			tx.Table("project_asset_candidates").
				Joins("JOIN projects ON projects.id = project_asset_candidates.project_id").
				Where("projects.user_id = ? AND project_asset_candidates.details_json <> ''", userID),
			"project_asset_candidates.details_json",
		).Pluck("project_asset_candidates.details_json", &docs).Error; err != nil {
			return err
		}
		for _, doc := range docs {
			if assets.DocumentReferences(doc, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.WorkflowStepInstance{}) && tx.Migrator().HasTable(&model.WorkflowInstance{}) && tx.Migrator().HasTable(&model.Project{}) {
		type stepDoc struct {
			InputJSON  string
			OutputJSON string
		}
		var steps []stepDoc
		if err := applySQLiteReferenceFilter(
			tx.Table("workflow_step_instances").
				Select("workflow_step_instances.input_json, workflow_step_instances.output_json").
				Joins("JOIN workflow_instances ON workflow_instances.id = workflow_step_instances.workflow_instance_id").
				Joins("JOIN projects ON projects.id = workflow_instances.project_id").
				Where("projects.user_id = ? AND (workflow_step_instances.input_json <> '' OR workflow_step_instances.output_json <> '')", userID),
			"workflow_step_instances.input_json", "workflow_step_instances.output_json",
		).Scan(&steps).Error; err != nil {
			return err
		}
		for _, step := range steps {
			if assets.DocumentReferences(step.InputJSON, idSet) || assets.DocumentReferences(step.OutputJSON, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	if tx.Migrator().HasTable(&model.ShotArtifact{}) && tx.Migrator().HasTable(&model.Shot{}) && tx.Migrator().HasTable(&model.Project{}) {
		var docs []string
		if err := applySQLiteReferenceFilter(
			tx.Table("shot_artifacts").
				Joins("JOIN shots ON shots.id = shot_artifacts.shot_id").
				Joins("JOIN projects ON projects.id = shots.project_id").
				Where("projects.user_id = ? AND shot_artifacts.metadata_json <> ''", userID),
			"shot_artifacts.metadata_json",
		).Pluck("shot_artifacts.metadata_json", &docs).Error; err != nil {
			return err
		}
		for _, doc := range docs {
			if assets.DocumentReferences(doc, idSet) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	return nil
}
