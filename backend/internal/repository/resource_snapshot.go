package repository

import "infinite-canvas/backend/internal/model"

// ResourceReferenceDocument 是资源删除校验使用的只读业务文档快照。
// repository 只按用户范围读取记录；JSON 中的资源引用合同由 service 统一解释。
type ResourceReferenceDocument struct {
	Kind                    string
	ID                      string
	Title                   string
	TaskID                  string
	PrimaryJSON             string
	SecondaryJSON           string
	PrimaryMatchedIDs       []string
	SecondaryMatchedIDs     []string
	TaskStatus              model.TaskStatus
	RetainedCompletedOutput bool
}

type ResourceDirectReference struct {
	Kind       string
	ID         string
	Title      string
	ResourceID string
}

type ResourceReferenceSnapshot struct {
	Documents []ResourceReferenceDocument
	Direct    []ResourceDirectReference
	Watermark SQLiteSnapshotWatermark
}

func (r *Repository) ResourceReferenceSnapshot(userID string, excludingAssetID string, resourceIDs []string) (ResourceReferenceSnapshot, error) {
	if excludingAssetID == "" {
		return r.ResourceReferenceSnapshotExcluding(userID, nil, resourceIDs)
	}
	return r.ResourceReferenceSnapshotExcluding(userID, []string{excludingAssetID}, resourceIDs)
}

func (r *Repository) ResourceReferenceSnapshotExcluding(userID string, excludingAssetIDs []string, resourceIDs []string) (ResourceReferenceSnapshot, error) {
	snapshot := ResourceReferenceSnapshot{
		Documents: []ResourceReferenceDocument{},
		Direct:    []ResourceDirectReference{},
	}
	if len(resourceIDs) == 0 {
		return snapshot, nil
	}
	candidateSet := make(map[string]struct{}, len(resourceIDs))
	remaining := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		candidateSet[resourceID] = struct{}{}
		remaining[resourceID] = struct{}{}
	}
	snapshot.Watermark = r.captureSQLiteWatermark(r.db, userID, excludingAssetIDs, candidateSet)

	directRefs, err := collectDirectResourceReferencesExcluding(r.db, userID, excludingAssetIDs, resourceIDs, true, false)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, directRefs...)
	for _, ref := range directRefs {
		delete(remaining, ref.ResourceID)
	}
	if len(remaining) == 0 {
		return snapshot, nil
	}

	var outputMatcher *deletedGenerationOutputMatcher
	if len(excludingAssetIDs) > 0 && r.db.Migrator().HasTable(&model.Asset{}) {
		var excludingAssets []model.Asset
		if err := r.db.Where("user_id = ? AND id IN ?", userID, excludingAssetIDs).Find(&excludingAssets).Error; err != nil {
			return snapshot, err
		}
		if len(excludingAssets) > 0 {
			outputMatcher = newDeletedGenerationOutputMatcher(excludingAssets)
		}
	}

	if err := scanReferenceDocuments(r.db, documentScanOptions{
		userID:               userID,
		excludingAssetIDs:    excludingAssetIDs,
		remaining:            remaining,
		deletedOutputMatcher: outputMatcher,
	}, &snapshot.Documents); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}
