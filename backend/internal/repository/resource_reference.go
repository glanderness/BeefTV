package repository

import (
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func (r *Repository) AssetResourceRecords(assetID string) ([]model.AssetVersion, []model.AssetRepresentation, error) {
	var versions []model.AssetVersion
	if err := r.db.Where("asset_id = ?", assetID).Find(&versions).Error; err != nil {
		return nil, nil, err
	}
	if len(versions) == 0 {
		return versions, nil, nil
	}
	versionIDs := make([]string, 0, len(versions))
	for _, version := range versions {
		versionIDs = append(versionIDs, version.ID)
	}
	var representations []model.AssetRepresentation
	if err := r.db.Where("asset_version_id IN ?", versionIDs).Find(&representations).Error; err != nil {
		return nil, nil, err
	}
	return versions, representations, nil
}

func (r *Repository) ResourcesForUserIDs(userID string, resourceIDs []string) ([]model.Resource, error) {
	if len(resourceIDs) == 0 {
		return []model.Resource{}, nil
	}
	var resources []model.Resource
	err := r.db.Where("user_id = ? AND id IN ?", userID, resourceIDs).Find(&resources).Error
	return resources, err
}

// ResourceStorageReferenceCount 返回未包含在 excludedResourceIDs 中、但指向同一物理对象的资源记录数。
// 这用于兼容历史数据中多个 Resource 行复用一个对象路径的情况。
func (r *Repository) ResourceStorageReferenceCount(resource *model.Resource, excludedResourceIDs []string) (int64, error) {
	if resource == nil {
		return 0, nil
	}
	query := r.db.Model(&model.Resource{}).
		Where("endpoint = ? AND bucket = ? AND object_key = ?", resource.Endpoint, resource.Bucket, resource.ObjectKey)
	if strings.TrimSpace(resource.Provider) == "" || strings.EqualFold(strings.TrimSpace(resource.Provider), "local") {
		query = query.Where("provider IN ?", []string{"", "local"})
	} else {
		query = query.Where("provider = ?", resource.Provider)
	}
	if len(excludedResourceIDs) > 0 {
		query = query.Where("id NOT IN ?", excludedResourceIDs)
	}
	var count int64
	err := query.Count(&count).Error
	return count, err
}

func (r *Repository) AssetBusinessReferences(userID string, assetID string) ([]ResourceDirectReference, error) {
	type projectReference struct {
		ID    string
		Title string
	}
	var projects []projectReference
	if err := r.db.Table("project_asset_links").
		Distinct("projects.id, projects.name AS title").
		Joins("JOIN projects ON projects.id = project_asset_links.project_id").
		Where("projects.user_id = ? AND project_asset_links.asset_id = ?", userID, assetID).
		Scan(&projects).Error; err != nil {
		return nil, err
	}
	var shotProjects []projectReference
	if err := r.db.Table("shot_asset_references").
		Distinct("projects.id, projects.name AS title").
		Joins("JOIN asset_versions ON asset_versions.id = shot_asset_references.asset_version_id").
		Joins("JOIN shots ON shots.id = shot_asset_references.shot_id").
		Joins("JOIN projects ON projects.id = shots.project_id").
		Where("projects.user_id = ? AND asset_versions.asset_id = ?", userID, assetID).
		Scan(&shotProjects).Error; err != nil {
		return nil, err
	}
	var candidateProjects []projectReference
	if err := r.db.Table("project_asset_candidates").
		Distinct("projects.id, projects.name AS title").
		Joins("JOIN projects ON projects.id = project_asset_candidates.project_id").
		Where("projects.user_id = ? AND project_asset_candidates.resolved_asset_id = ?", userID, assetID).
		Scan(&candidateProjects).Error; err != nil {
		return nil, err
	}
	result := make([]ResourceDirectReference, 0, len(projects)+len(shotProjects)+len(candidateProjects))
	for _, project := range append(append(projects, shotProjects...), candidateProjects...) {
		result = append(result, ResourceDirectReference{Kind: "项目", ID: project.ID, Title: project.Title})
	}
	return result, nil
}

// DeleteAssetAndResources removes the owned asset and its resources in one
// IMMEDIATE writer transaction. expectedStatus, when set, is checked against
// the row and applied to the delete so a restore cannot commit with this TX.
func (r *Repository) DeleteAssetAndResources(userID string, assetID string, resourceIDs []string, deletionJobs []model.ResourceDeletionJob, expectedStatus ...string) error {
	expected := ""
	if len(expectedStatus) > 0 {
		expected = strings.TrimSpace(expectedStatus[0])
	}
	return withImmediateTransaction(r.db, func(tx *gorm.DB) error {
		var asset model.Asset
		if err := tx.Where("id = ? AND user_id = ?", assetID, userID).First(&asset).Error; err != nil {
			return err
		}
		if expected != "" && string(asset.Status) != expected {
			return ErrAssetExpectedStatusMismatch
		}
		if err := guardAssetBusinessLinks(tx, assetID); err != nil {
			return err
		}
		if err := guardAssetDeletionReferences(tx, userID, assetID, resourceIDs); err != nil {
			return err
		}
		if tx.Migrator().HasTable(&model.CanvasSnapshotResource{}) {
			if err := New(tx).RequireNoCanvasHistoryReferences(resourceIDs); err != nil {
				return err
			}
		}
		versionIDs := tx.Model(&model.AssetVersion{}).Select("id").Where("asset_id = ?", assetID)
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Delete(&model.ShotAssetReference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Delete(&model.CharacterVoiceBinding{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Delete(&model.AssetRepresentation{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_id = ?", assetID).Delete(&model.ProjectAssetLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("resolved_asset_id = ?", assetID).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_id = ?", assetID).Delete(&model.AssetVersion{}).Error; err != nil {
			return err
		}
		if expected != "" {
			result := tx.Where("id = ? AND user_id = ? AND status = ?", assetID, userID, expected).Delete(&model.Asset{})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return ErrAssetExpectedStatusMismatch
			}
		} else if err := tx.Delete(&model.Asset{}, "id = ? AND user_id = ?", assetID, userID).Error; err != nil {
			return err
		}
		if len(deletionJobs) > 0 {
			if err := tx.Create(&deletionJobs).Error; err != nil {
				return err
			}
		}
		if len(resourceIDs) == 0 {
			return nil
		}
		if err := tx.Where("resource_id IN ?", resourceIDs).Delete(&model.ArkPrivateAssetBinding{}).Error; err != nil {
			return err
		}
		var resources []model.Resource
		if err := tx.Where("user_id = ? AND id IN ?", userID, resourceIDs).Find(&resources).Error; err != nil {
			return err
		}
		if err := settleDeletedResources(tx, resources); err != nil {
			return err
		}
		return tx.Where("user_id = ? AND id IN ?", userID, resourceIDs).Delete(&model.Resource{}).Error
	})
}

func withImmediateTransaction(db *gorm.DB, fn func(*gorm.DB) error) error {
	if db == nil {
		return gorm.ErrInvalidDB
	}
	// Creation approval already owns a transaction. Taking another pooled
	// connection here would deadlock the single-connection desktop database
	// and detach task admission from its approval/receipt rollback.
	if _, insideTransaction := db.Statement.ConnPool.(gorm.TxCommitter); insideTransaction {
		return db.Transaction(fn)
	}
	return db.Connection(func(conn *gorm.DB) error {
		tx := conn.Session(&gorm.Session{SkipDefaultTransaction: true, NewDB: true})
		if err := tx.Exec("BEGIN IMMEDIATE").Error; err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Exec("ROLLBACK").Error
			}
		}()
		if err := fn(tx); err != nil {
			return err
		}
		if err := tx.Exec("COMMIT").Error; err != nil {
			return err
		}
		committed = true
		return nil
	})
}

// RequireReadyOwnedResourcesTx is the admission-side counterpart of
// DeleteAssetAndResources. CreateTaskWithActiveLimit and RetryTask call it
// after resolving input resource IDs and before Create/Updates, in the same
// transaction as the task write.
//
// The no-op UPDATE takes SQLite's writer lock so WAL cannot commit a delete
// between the readiness check and the task insert. A plain SELECT is not
// enough: WAL readers do not block BEGIN IMMEDIATE. This package does not
// change the task worker.
func RequireReadyOwnedResourcesTx(tx *gorm.DB, userID string, resourceIDs []string) error {
	if tx == nil {
		return gorm.ErrInvalidDB
	}
	unique, err := uniqueResourceIDs(resourceIDs)
	if err != nil {
		return err
	}
	if len(unique) == 0 {
		return nil
	}
	result := tx.Model(&model.Resource{}).
		Where("user_id = ? AND id IN ? AND status = ?", userID, unique, model.ResourceStatusReady).
		UpdateColumn("id", gorm.Expr("id"))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != int64(len(unique)) {
		return ErrResourceNotReadyForAdmission
	}
	return nil
}

func uniqueResourceIDs(resourceIDs []string) ([]string, error) {
	seen := make(map[string]struct{}, len(resourceIDs))
	unique := make([]string, 0, len(resourceIDs))
	for _, id := range resourceIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, ErrResourceNotReadyForAdmission
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	return unique, nil
}

func (r *Repository) RequireReadyOwnedResources(userID string, resourceIDs []string) error {
	if r == nil || r.db == nil {
		return gorm.ErrInvalidDB
	}
	return RequireReadyOwnedResourcesTx(r.db, userID, resourceIDs)
}
