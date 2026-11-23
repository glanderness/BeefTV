package repository

import (
	"errors"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var ErrResourceCleanupSetChanged = errors.New("resource cleanup set changed")
var ErrResourceCleanupStillReferenced = errors.New("resource cleanup resource is still directly referenced")
var ErrResourceCleanupSnapshotStale = errors.New("resource cleanup snapshot watermark changed")
var ErrResourceNotReadyForAdmission = errors.New("resource is not ready for admission")
var ErrTaskInputInvalid = errors.New("task input is invalid")

// DeleteDetachedResources removes Resource rows and enqueues physical deletion in one transaction.
// All indexed direct-reference checks always run under BEGIN IMMEDIATE (including on the
// watermark fast path) so orphaned FK rows can never lose their media.
//
// When a verified single-connection SQLite watermark from the preceding
// ResourceReferenceSnapshot covers every resource in the batch:
//   - If SQLite's connection and change counters still match inside BEGIN IMMEDIATE,
//     no SQLite writes occurred in between and the expensive JSON document scan is skipped.
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
		if err := tx.Where("id IN ?", resourceIDs).Find(&current).Error; err != nil {
			return err
		}
		if len(current) != len(resources) {
			return ErrResourceCleanupSetChanged
		}
		skipDocumentScan := false
		if watermark.covers(current) {
			if !r.watermarkMatchesTx(tx, watermark) {
				return ErrResourceCleanupSnapshotStale
			}
			skipDocumentScan = true
		}

		idsByUser := map[string][]string{}
		for _, resource := range current {
			idsByUser[resource.UserID] = append(idsByUser[resource.UserID], resource.ID)
		}
		for userID, ids := range idsByUser {
			directRefs, err := collectDirectResourceReferences(tx, userID, "", ids, true, true)
			if err != nil {
				return err
			}
			if len(directRefs) > 0 {
				return ErrResourceCleanupStillReferenced
			}
		}
		if !skipDocumentScan {
			for userID, ids := range idsByUser {
				if err := guardReferenceDocuments(tx, userID, "", ids, false); err != nil {
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
