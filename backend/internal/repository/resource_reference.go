package repository

import (
	"slices"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// ResourceReferenceDocument 是资源删除校验使用的只读业务文档快照。
// repository 只按用户范围读取记录；JSON 中的资源引用合同由 service 统一解释。
type ResourceReferenceDocument struct {
	Kind          string
	ID            string
	Title         string
	PrimaryJSON   string
	SecondaryJSON string
	TaskStatus    model.TaskStatus
}

type ResourceDirectReference struct {
	Kind       string
	ID         string
	Title      string
	ResourceID string
}

// SQLiteSnapshotWatermark records the database change counters observed before
// a read-only reference snapshot on a single-connection SQLite database. If the
// counters still match inside BEGIN IMMEDIATE, no writes occurred anywhere in
// SQLite since the snapshot began.
type SQLiteSnapshotWatermark struct {
	Valid        bool
	DataVersion  int64
	TotalChanges int64
}

type ResourceReferenceSnapshot struct {
	Documents []ResourceReferenceDocument
	Direct    []ResourceDirectReference
	Watermark SQLiteSnapshotWatermark
}

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

func (r *Repository) ResourceReferenceSnapshot(userID string, excludingAssetID string, resourceIDs []string) (ResourceReferenceSnapshot, error) {
	snapshot := ResourceReferenceSnapshot{Documents: []ResourceReferenceDocument{}, Direct: []ResourceDirectReference{}}
	if len(resourceIDs) == 0 {
		return snapshot, nil
	}
	snapshot.Watermark = r.captureSQLiteWatermark(r.db)
	candidateSet := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		candidateSet[resourceID] = struct{}{}
	}
	history, err := r.CanvasHistoryResourceReferences(resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, history...)
	exports, err := r.ProjectExportResourceReferences(userID, resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, exports...)
	if r.db.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
		var refs []model.CanvasWorkflowResource
		if err := r.db.Where("user_id = ? AND resource_id IN ?", userID, resourceIDs).Find(&refs).Error; err != nil {
			return snapshot, err
		}
		for _, ref := range refs {
			snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "可复用工作流", ID: ref.OwnerID, Title: "工作流模板或运行结果", ResourceID: ref.ResourceID})
		}
	}

	var assetRows []model.Asset
	assetQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "title", "payload_json").Where("user_id = ? AND id <> ? AND payload_json <> ''", userID, excludingAssetID),
		"payload_json",
	)
	if err := assetQuery.Find(&assetRows).Error; err != nil {
		return snapshot, err
	}
	for _, asset := range assetRows {
		if assets.DocumentReferences(asset.PayloadJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "素材", ID: asset.ID, Title: asset.Title, PrimaryJSON: asset.PayloadJSON})
		}
	}

	// Scan canvas_projects in small ID-ordered chunks and match in Go (SIMD) so
	// large multi-megabyte canvases yield SQLite's single connection every ~5ms
	// and never retain unmatched canvas payloads in memory.
	var canvasIDs []string
	if err := r.db.Model(&model.CanvasProject{}).Where("user_id = ?", userID).Order("id ASC").Pluck("id", &canvasIDs).Error; err != nil {
		return snapshot, err
	}
	const canvasChunkSize = 2
	for start := 0; start < len(canvasIDs); start += canvasChunkSize {
		end := min(start+canvasChunkSize, len(canvasIDs))
		var canvases []model.CanvasProject
		if err := r.db.Select("id", "title", "payload_json").Where("user_id = ? AND id IN ? AND payload_json <> ''", userID, canvasIDs[start:end]).Find(&canvases).Error; err != nil {
			return snapshot, err
		}
		for _, canvas := range canvases {
			if assets.DocumentReferences(canvas.PayloadJSON, candidateSet) {
				snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "画布", ID: canvas.ID, Title: canvas.Title, PrimaryJSON: canvas.PayloadJSON})
			}
		}
	}

	var tasks []model.Task
	taskQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "prompt", "status", "input_json", "result_json").Where("user_id = ? AND (input_json <> '' OR result_json <> '')", userID),
		"input_json", "result_json",
	)
	if err := taskQuery.Find(&tasks).Error; err != nil {
		return snapshot, err
	}
	taskStatuses := make(map[string]model.TaskStatus, len(tasks))
	for _, task := range tasks {
		taskStatuses[task.ID] = task.Status
		if assets.DocumentReferences(task.InputJSON, candidateSet) || assets.DocumentReferences(task.ResultJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "任务", ID: task.ID, Title: task.Prompt, PrimaryJSON: task.InputJSON, SecondaryJSON: task.ResultJSON, TaskStatus: task.Status})
		}
	}

	var runs []model.CreationRun
	runQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "state_json", "approved_operations_json").Where("user_id = ? AND (state_json <> '' OR approved_operations_json <> '')", userID),
		"state_json", "approved_operations_json",
	)
	if err := runQuery.Find(&runs).Error; err != nil {
		return snapshot, err
	}
	for _, run := range runs {
		if assets.DocumentReferences(run.StateJSON, candidateSet) || assets.DocumentReferences(run.ApprovedOperationsJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "创作会话", ID: run.ID, Title: "智能创作", PrimaryJSON: run.StateJSON, SecondaryJSON: run.ApprovedOperationsJSON})
		}
	}
	var submissions []model.CreationSubmission
	submissionQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "item_key", "request_json").Where("user_id = ? AND revoked_at IS NULL AND request_json <> ''", userID),
		"request_json",
	)
	if err := submissionQuery.Find(&submissions).Error; err != nil {
		return snapshot, err
	}
	for _, submission := range submissions {
		if assets.DocumentReferences(submission.RequestJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "创作执行项", ID: submission.ID, Title: submission.ItemKey, PrimaryJSON: submission.RequestJSON})
		}
	}

	var taskLogs []model.TaskLog
	taskLogQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "task_id", "message", "payload").Where("user_id = ? AND payload <> ''", userID),
		"payload",
	)
	if err := taskLogQuery.Find(&taskLogs).Error; err != nil {
		return snapshot, err
	}
	var matchedLogs []model.TaskLog
	for _, taskLog := range taskLogs {
		if assets.DocumentReferences(taskLog.Payload, candidateSet) {
			matchedLogs = append(matchedLogs, taskLog)
		}
	}
	var results []model.Result
	resultQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "task_id", "kind", "url", "payload").Where("user_id = ? AND (url <> '' OR payload <> '')", userID),
		"url", "payload",
	)
	if err := resultQuery.Find(&results).Error; err != nil {
		return snapshot, err
	}
	var matchedResults []model.Result
	for _, result := range results {
		if assets.DocumentReferences(result.URL, candidateSet) || assets.DocumentReferences(result.Payload, candidateSet) {
			matchedResults = append(matchedResults, result)
		}
	}
	if err := populateMissingTaskStatuses(r.db, userID, taskStatuses, matchedLogs, matchedResults); err != nil {
		return snapshot, err
	}
	for _, taskLog := range matchedLogs {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "任务日志", ID: taskLog.ID, Title: taskLog.Message, PrimaryJSON: taskLog.Payload, TaskStatus: taskStatuses[taskLog.TaskID]})
	}
	for _, result := range matchedResults {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "任务结果", ID: result.ID, Title: result.Kind, PrimaryJSON: result.URL, SecondaryJSON: result.Payload, TaskStatus: taskStatuses[result.TaskID]})
	}

	var coverProjects []model.Project
	if err := r.db.Select("id", "name", "cover_resource_id").Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).Find(&coverProjects).Error; err != nil {
		return snapshot, err
	}
	for _, project := range coverProjects {
		if project.CoverResourceID != "" && slices.Contains(resourceIDs, project.CoverResourceID) {
			snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "项目主图", ID: project.ID, Title: project.Name, ResourceID: project.CoverResourceID})
		}
	}
	var projects []model.Project
	projectStyleQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "name", "style_profile_json").Where("user_id = ? AND style_profile_json <> ''", userID),
		"style_profile_json",
	)
	if err := projectStyleQuery.Find(&projects).Error; err != nil {
		return snapshot, err
	}
	for _, project := range projects {
		if assets.DocumentReferences(project.StyleProfileJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "项目", ID: project.ID, Title: project.Name, PrimaryJSON: project.StyleProfileJSON})
		}
	}

	var styles []model.StyleProfile
	styleQuery := applySQLiteReferenceFilter(
		r.db.Select("id", "name", "cover_url", "profile_json").Where("user_id = ? AND (cover_url <> '' OR profile_json <> '')", userID),
		"cover_url", "profile_json",
	)
	if err := styleQuery.Find(&styles).Error; err != nil {
		return snapshot, err
	}
	for _, style := range styles {
		if assets.DocumentReferences(style.CoverURL, candidateSet) || assets.DocumentReferences(style.ProfileJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "风格", ID: style.ID, Title: style.Name, PrimaryJSON: style.CoverURL, SecondaryJSON: style.ProfileJSON})
		}
	}

	type joinedDocument struct {
		ID            string
		Title         string
		PrimaryJSON   string
		SecondaryJSON string
	}
	var versions []joinedDocument
	versionQuery := applySQLiteReferenceFilter(
		r.db.Table("asset_versions").
			Select("asset_versions.id, assets.title, asset_versions.definition_json AS primary_json").
			Joins("JOIN assets ON assets.id = asset_versions.asset_id").
			Where("assets.user_id = ? AND assets.id <> ? AND asset_versions.definition_json <> ''", userID, excludingAssetID),
		"asset_versions.definition_json",
	)
	if err := versionQuery.Scan(&versions).Error; err != nil {
		return snapshot, err
	}
	for _, version := range versions {
		if assets.DocumentReferences(version.PrimaryJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "素材", ID: version.ID, Title: version.Title, PrimaryJSON: version.PrimaryJSON})
		}
	}

	var candidates []joinedDocument
	candidateQuery := applySQLiteReferenceFilter(
		r.db.Table("project_asset_candidates").
			Select("project_asset_candidates.id, projects.name AS title, project_asset_candidates.details_json AS primary_json").
			Joins("JOIN projects ON projects.id = project_asset_candidates.project_id").
			Where("projects.user_id = ? AND project_asset_candidates.details_json <> ''", userID),
		"project_asset_candidates.details_json",
	)
	if err := candidateQuery.Scan(&candidates).Error; err != nil {
		return snapshot, err
	}
	for _, candidate := range candidates {
		if assets.DocumentReferences(candidate.PrimaryJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "项目", ID: candidate.ID, Title: candidate.Title, PrimaryJSON: candidate.PrimaryJSON})
		}
	}

	var steps []joinedDocument
	stepQuery := applySQLiteReferenceFilter(
		r.db.Table("workflow_step_instances").
			Select("workflow_step_instances.id, workflow_step_instances.name AS title, workflow_step_instances.input_json AS primary_json, workflow_step_instances.output_json AS secondary_json").
			Joins("JOIN workflow_instances ON workflow_instances.id = workflow_step_instances.workflow_instance_id").
			Joins("JOIN projects ON projects.id = workflow_instances.project_id").
			Where("projects.user_id = ? AND (workflow_step_instances.input_json <> '' OR workflow_step_instances.output_json <> '')", userID),
		"workflow_step_instances.input_json", "workflow_step_instances.output_json",
	)
	if err := stepQuery.Scan(&steps).Error; err != nil {
		return snapshot, err
	}
	for _, step := range steps {
		if assets.DocumentReferences(step.PrimaryJSON, candidateSet) || assets.DocumentReferences(step.SecondaryJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "工作流", ID: step.ID, Title: step.Title, PrimaryJSON: step.PrimaryJSON, SecondaryJSON: step.SecondaryJSON})
		}
	}

	var shotArtifacts []joinedDocument
	artifactDocumentQuery := applySQLiteReferenceFilter(
		r.db.Table("shot_artifacts").
			Select("shot_artifacts.id, shots.title, shot_artifacts.metadata_json AS primary_json").
			Joins("JOIN shots ON shots.id = shot_artifacts.shot_id").
			Joins("JOIN projects ON projects.id = shots.project_id").
			Where("projects.user_id = ? AND shot_artifacts.metadata_json <> ''", userID),
		"shot_artifacts.metadata_json",
	)
	if err := artifactDocumentQuery.Scan(&shotArtifacts).Error; err != nil {
		return snapshot, err
	}
	for _, artifact := range shotArtifacts {
		if assets.DocumentReferences(artifact.PrimaryJSON, candidateSet) {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "镜头产物", ID: artifact.ID, Title: artifact.Title, PrimaryJSON: artifact.PrimaryJSON})
		}
	}

	type joinedRepresentation struct {
		ID         string
		Title      string
		ResourceID string
	}
	var representations []joinedRepresentation
	if err := r.db.Table("asset_representations").
		Select("asset_representations.id, assets.title, asset_representations.resource_id").
		Joins("JOIN asset_versions ON asset_versions.id = asset_representations.asset_version_id").
		Joins("JOIN assets ON assets.id = asset_versions.asset_id").
		Where("assets.user_id = ? AND assets.id <> ? AND asset_representations.resource_id IN ?", userID, excludingAssetID, resourceIDs).
		Scan(&representations).Error; err != nil {
		return snapshot, err
	}
	for _, representation := range representations {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "素材", ID: representation.ID, Title: representation.Title, ResourceID: representation.ResourceID})
	}

	var voices []model.VoiceProfile
	if err := r.db.Where("user_id = ? AND sample_resource_id IN ?", userID, resourceIDs).Find(&voices).Error; err != nil {
		return snapshot, err
	}
	for _, voice := range voices {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "声音", ID: voice.ID, Title: voice.Name, ResourceID: voice.SampleResourceID})
	}

	type joinedShotArtifact struct {
		ID         string
		Title      string
		ResourceID string
	}
	var artifacts []joinedShotArtifact
	if err := r.db.Table("shot_artifacts").
		Select("shot_artifacts.id, shots.title, shot_artifacts.resource_id").
		Joins("JOIN shots ON shots.id = shot_artifacts.shot_id").
		Joins("JOIN projects ON projects.id = shots.project_id").
		Where("projects.user_id = ? AND shot_artifacts.resource_id IN ?", userID, resourceIDs).
		Scan(&artifacts).Error; err != nil {
		return snapshot, err
	}
	for _, artifact := range artifacts {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "镜头产物", ID: artifact.ID, Title: artifact.Title, ResourceID: artifact.ResourceID})
	}

	libraryRefs, err := r.CanvasLibraryResourceReferences(userID, resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, libraryRefs...)

	return snapshot, nil
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
		if err := guardAssetDeletionReferences(tx, userID, assetID, resourceIDs); err != nil {
			return err
		}
		if err := New(tx).RequireNoCanvasHistoryReferences(resourceIDs); err != nil {
			return err
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

// guardAssetDeletionReferences re-checks live documents and direct links inside
// the delete transaction so a reference added after the service snapshot cannot
// commit with the resource rows and outbox.
func guardAssetDeletionReferences(tx *gorm.DB, userID string, assetID string, resourceIDs []string) error {
	if err := guardAssetBusinessLinks(tx, assetID); err != nil {
		return err
	}
	if len(resourceIDs) == 0 {
		return nil
	}
	var assetDocuments []string
	if err := applySQLiteReferenceFilter(
		tx.Model(&model.Asset{}).Where("user_id = ? AND id <> ? AND payload_json <> ''", userID, assetID),
		"payload_json",
	).Pluck("payload_json", &assetDocuments).Error; err != nil {
		return err
	}
	var canvasDocuments []string
	if err := tx.Model(&model.CanvasProject{}).Where("user_id = ? AND payload_json <> ''", userID).Pluck("payload_json", &canvasDocuments).Error; err != nil {
		return err
	}
	documents := append(assetDocuments, canvasDocuments...)
	idSet := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		idSet[resourceID] = struct{}{}
	}
	for _, document := range documents {
		if assets.DocumentReferences(document, idSet) {
			return ErrResourceCleanupStillReferenced
		}
	}
	var representationCount int64
	if err := tx.Table("asset_representations").
		Joins("JOIN asset_versions ON asset_versions.id = asset_representations.asset_version_id").
		Where("asset_versions.asset_id <> ? AND asset_representations.resource_id IN ?", assetID, resourceIDs).
		Count(&representationCount).Error; err != nil {
		return err
	}
	if representationCount > 0 {
		return ErrResourceCleanupStillReferenced
	}
	for _, check := range []struct {
		model any
		query string
	}{
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
	if err := guardCanvasLibraryResourceReferences(tx, userID, resourceIDs); err != nil {
		return err
	}
	if err := guardCanvasWorkflowResourceReferences(tx, userID, resourceIDs); err != nil {
		return err
	}
	return guardTaskResourceReferences(tx, userID, resourceIDs, true)
}

func guardCanvasWorkflowResourceReferences(tx *gorm.DB, userID string, resourceIDs []string) error {
	if len(resourceIDs) == 0 || !tx.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
		return nil
	}
	var count int64
	if err := tx.Model(&model.CanvasWorkflowResource{}).Where("user_id = ? AND resource_id IN ?", userID, resourceIDs).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrResourceCleanupStillReferenced
	}
	return nil
}

func guardCanvasLibraryResourceReferences(tx *gorm.DB, userID string, resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	if tx.Migrator().HasTable(&model.CanvasDrawing{}) {
		var count int64
		if err := liveCanvasDrawings(tx.Model(&model.CanvasDrawing{})).
			Where("user_id = ? AND (preview_resource_id IN ? OR render_resource_id IN ?)", userID, resourceIDs, resourceIDs).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	if tx.Migrator().HasTable(&model.CanvasLibraryFolder{}) {
		var count int64
		if err := liveCanvasLibraryFolders(tx.Model(&model.CanvasLibraryFolder{})).
			Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	return nil
}

func guardTaskResourceReferences(tx *gorm.DB, userID string, resourceIDs []string, skipCompletedOutput bool) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	owned := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		owned[resourceID] = struct{}{}
	}
	var tasks []model.Task
	taskQuery := applySQLiteReferenceFilter(
		tx.Select("id", "status", "input_json", "result_json").Where("user_id = ? AND (input_json <> '' OR result_json <> '')", userID),
		"input_json", "result_json",
	)
	if err := taskQuery.Find(&tasks).Error; err != nil {
		return err
	}
	var statuses map[string]model.TaskStatus
	if skipCompletedOutput {
		statuses = make(map[string]model.TaskStatus, len(tasks))
	}
	for _, task := range tasks {
		if skipCompletedOutput {
			statuses[task.ID] = task.Status
		}
		primary, secondary := task.InputJSON, task.ResultJSON
		if skipCompletedOutput {
			switch task.Status {
			case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
				secondary = ""
			}
		}
		if assets.DocumentReferences(primary, owned) || assets.DocumentReferences(secondary, owned) {
			return ErrResourceCleanupStillReferenced
		}
	}
	var logs []model.TaskLog
	logQuery := applySQLiteReferenceFilter(
		tx.Select("id", "task_id", "payload").Where("user_id = ? AND payload <> ''", userID),
		"payload",
	)
	if err := logQuery.Find(&logs).Error; err != nil {
		return err
	}
	var results []model.Result
	resultQuery := applySQLiteReferenceFilter(
		tx.Select("id", "task_id", "url", "payload").Where("user_id = ? AND (url <> '' OR payload <> '')", userID),
		"url", "payload",
	)
	if err := resultQuery.Find(&results).Error; err != nil {
		return err
	}
	var matchedLogs []model.TaskLog
	for _, log := range logs {
		if assets.DocumentReferences(log.Payload, owned) {
			matchedLogs = append(matchedLogs, log)
		}
	}
	var matchedResults []model.Result
	for _, result := range results {
		if assets.DocumentReferences(result.URL, owned) || assets.DocumentReferences(result.Payload, owned) {
			matchedResults = append(matchedResults, result)
		}
	}
	if !skipCompletedOutput {
		if len(matchedLogs) > 0 || len(matchedResults) > 0 {
			return ErrResourceCleanupStillReferenced
		}
		return nil
	}
	if err := populateMissingTaskStatuses(tx, userID, statuses, matchedLogs, matchedResults); err != nil {
		return err
	}
	for _, log := range matchedLogs {
		switch statuses[log.TaskID] {
		case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
			continue
		default:
			return ErrResourceCleanupStillReferenced
		}
	}
	for _, result := range matchedResults {
		switch statuses[result.TaskID] {
		case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
			continue
		default:
			return ErrResourceCleanupStillReferenced
		}
	}
	return nil
}

func populateMissingTaskStatuses(db *gorm.DB, userID string, statuses map[string]model.TaskStatus, logs []model.TaskLog, results []model.Result) error {
	missing := make([]string, 0)
	seen := map[string]struct{}{}
	collect := func(taskID string) {
		if taskID == "" {
			return
		}
		if _, ok := statuses[taskID]; ok {
			return
		}
		if _, dup := seen[taskID]; dup {
			return
		}
		seen[taskID] = struct{}{}
		missing = append(missing, taskID)
	}
	for _, log := range logs {
		collect(log.TaskID)
	}
	for _, result := range results {
		collect(result.TaskID)
	}
	if len(missing) == 0 {
		return nil
	}
	var rows []model.Task
	if err := db.Select("id", "status").Where("user_id = ? AND id IN ?", userID, missing).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		statuses[row.ID] = row.Status
	}
	return nil
}

// applySQLiteReferenceFilter narrows SQLite document rows using the single
// canonical prefilter token table in package assets.
func applySQLiteReferenceFilter(query *gorm.DB, columns ...string) *gorm.DB {
	if query == nil || query.Dialector == nil || query.Dialector.Name() != "sqlite" || len(columns) == 0 {
		return query
	}
	tokens := assets.ReferencePrefilterTokens()
	if len(tokens) == 0 {
		return query
	}
	clauses := make([]string, 0, len(columns)*len(tokens))
	args := make([]any, 0, len(columns)*len(tokens))
	for _, column := range columns {
		for _, token := range tokens {
			clauses = append(clauses, "instr("+column+", ?) > 0")
			args = append(args, token)
		}
	}
	return query.Where("("+strings.Join(clauses, " OR ")+")", args...)
}

func (r *Repository) captureSQLiteWatermark(db *gorm.DB) SQLiteSnapshotWatermark {
	if r == nil || !r.SingleProcess() || db == nil || db.Dialector == nil || db.Dialector.Name() != "sqlite" || r.HoldsTransaction() {
		return SQLiteSnapshotWatermark{}
	}
	sqlDB, err := db.DB()
	if err != nil || sqlDB.Stats().MaxOpenConnections != 1 {
		return SQLiteSnapshotWatermark{}
	}
	return readSQLiteWatermark(db)
}

func (r *Repository) watermarkMatchesTx(tx *gorm.DB, expected SQLiteSnapshotWatermark) bool {
	if !expected.Valid || r == nil || !r.SingleProcess() || tx == nil || tx.Dialector == nil || tx.Dialector.Name() != "sqlite" {
		return false
	}
	sqlDB, err := r.db.DB()
	if err != nil || sqlDB.Stats().MaxOpenConnections != 1 {
		return false
	}
	current := readSQLiteWatermark(tx)
	return current.Valid && current.DataVersion == expected.DataVersion && current.TotalChanges == expected.TotalChanges
}

func readSQLiteWatermark(db *gorm.DB) SQLiteSnapshotWatermark {
	var dataVersion int64
	if err := db.Raw("PRAGMA data_version").Scan(&dataVersion).Error; err != nil || dataVersion <= 0 {
		return SQLiteSnapshotWatermark{}
	}
	var totalChanges int64
	if err := db.Raw("SELECT total_changes()").Scan(&totalChanges).Error; err != nil || totalChanges <= 0 {
		return SQLiteSnapshotWatermark{}
	}
	return SQLiteSnapshotWatermark{
		Valid:        true,
		DataVersion:  dataVersion,
		TotalChanges: totalChanges,
	}
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

func guardAssetBusinessLinks(tx *gorm.DB, assetID string) error {
	for _, check := range []struct {
		model any
		query string
		args  []any
	}{
		{&model.ProjectAssetLink{}, "asset_id = ?", []any{assetID}},
		{&model.ProjectAssetCandidate{}, "resolved_asset_id = ?", []any{assetID}},
	} {
		var count int64
		if err := tx.Model(check.model).Where(check.query, check.args...).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	var shotCount int64
	if err := tx.Table("shot_asset_references").
		Joins("JOIN asset_versions ON asset_versions.id = shot_asset_references.asset_version_id").
		Where("asset_versions.asset_id = ?", assetID).
		Count(&shotCount).Error; err != nil {
		return err
	}
	if shotCount > 0 {
		return ErrResourceCleanupStillReferenced
	}
	return nil
}
