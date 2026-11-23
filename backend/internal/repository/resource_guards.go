package repository

import (
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

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
	idSet := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		idSet[resourceID] = struct{}{}
	}
	var assetDocuments []string
	if err := applySQLiteReferenceFilter(
		tx.Model(&model.Asset{}).Where("user_id = ? AND id <> ? AND payload_json <> ''", userID, assetID),
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
	exports, err := New(tx).ProjectExportResourceReferences(userID, resourceIDs)
	if err != nil {
		return err
	}
	if len(exports) > 0 {
		return ErrResourceCleanupStillReferenced
	}
	if err := guardAdditionalWorkspaceResourceReferences(tx, userID, assetID, resourceIDs); err != nil {
		return err
	}
	return guardTaskResourceReferences(tx, userID, resourceIDs, true)
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

// guardCanvasProjectReferences streams canvas_projects one row at a time and
// matches in Go (SIMD) so large canvases never allocate a multi-megabyte slice
// or run slow scalar SQLite instr() loops across payload blobs.
func guardCanvasProjectReferences(tx *gorm.DB, userID string, idSet map[string]struct{}) error {
	rows, err := tx.Model(&model.CanvasProject{}).
		Select("payload_json").
		Where("user_id = ? AND payload_json <> ''", userID).
		Rows()
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return err
		}
		if assets.DocumentReferences(payload, idSet) {
			return ErrResourceCleanupStillReferenced
		}
	}
	return rows.Err()
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

// guardAdditionalWorkspaceResourceReferences closes the race window for tables
// checked during snapshot scanning when snapshot collection runs outside
// storageMu or before DeleteAssetAndResources. Optional tables are checked only
// when present in the schema.
func guardAdditionalWorkspaceResourceReferences(tx *gorm.DB, userID string, excludingAssetID string, resourceIDs []string) error {
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
		query := tx.Table("asset_versions").
			Joins("JOIN assets ON assets.id = asset_versions.asset_id").
			Where("assets.user_id = ? AND asset_versions.definition_json <> ''", userID)
		if excludingAssetID != "" {
			query = query.Where("assets.id <> ?", excludingAssetID)
		}
		if err := applySQLiteReferenceFilter(query, "asset_versions.definition_json").
			Pluck("asset_versions.definition_json", &docs).Error; err != nil {
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
