package repository

import (
	"errors"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var ErrResourceCleanupSetChanged = errors.New("resource cleanup set changed")
var ErrResourceCleanupStillReferenced = errors.New("resource cleanup resource is still directly referenced")
var ErrResourceCleanupSnapshotStale = errors.New("resource cleanup snapshot watermark changed")
var ErrResourceNotReadyForAdmission = errors.New("resource is not ready for admission")
var ErrTaskInputInvalid = errors.New("task input is invalid")

// DeleteDetachedResources removes Resource rows and enqueues physical deletion in one transaction.
// JSON references are checked by the service before this call; direct foreign-key-like references
// and live task documents (including completed outputs) are checked again under BEGIN IMMEDIATE
// so a newly admitted task cannot lose its material.
//
// When a verified single-connection SQLite watermark from the preceding
// ResourceReferenceSnapshot covers every resource in the batch:
//   - If SQLite's connection and change counters still match inside BEGIN IMMEDIATE,
//     no SQLite writes occurred in between and the redundant full-table re-scan is skipped.
//   - If a write occurred after the snapshot began, DeleteDetachedResources returns
//     ErrResourceCleanupSnapshotStale immediately so BEGIN IMMEDIATE (and the caller's
//     storage lock) is released without holding a full-workspace scan under lock.
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
		skipGuards := false
		if watermark.covers(current) {
			if !r.watermarkMatchesTx(tx, watermark) {
				return ErrResourceCleanupSnapshotStale
			}
			skipGuards = true
		}
		if !skipGuards {
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
				if err := guardCanvasProjectReferences(tx, userID, idSet); err != nil {
					return err
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
				if err := guardAdditionalWorkspaceResourceReferences(tx, userID, "", ids); err != nil {
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
