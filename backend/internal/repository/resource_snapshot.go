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
	Kind                string
	ID                  string
	Title               string
	PrimaryJSON         string
	SecondaryJSON       string
	PrimaryMatchedIDs   []string
	SecondaryMatchedIDs []string
	TaskStatus          model.TaskStatus
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
	snapshot := ResourceReferenceSnapshot{Documents: []ResourceReferenceDocument{}, Direct: []ResourceDirectReference{}}
	if len(resourceIDs) == 0 {
		return snapshot, nil
	}
	candidateSet := make(map[string]struct{}, len(resourceIDs))
	remaining := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		candidateSet[resourceID] = struct{}{}
		remaining[resourceID] = struct{}{}
	}
	snapshot.Watermark = r.captureSQLiteWatermark(r.db, userID, excludingAssetID, candidateSet)

	pruneDirect := func(refs []ResourceDirectReference) {
		for _, ref := range refs {
			delete(remaining, ref.ResourceID)
		}
	}
	pruneSet := func(matched map[string]struct{}) {
		for id := range matched {
			delete(remaining, id)
		}
	}

	// Check indexed direct-reference tables first so callers always see direct
	// references and already-retained IDs are pruned before scanning JSON blobs.
	history, err := r.CanvasHistoryResourceReferences(resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, history...)
	pruneDirect(history)

	exports, err := r.ProjectExportResourceReferences(userID, resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, exports...)
	pruneDirect(exports)

	if r.db.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
		var refs []model.CanvasWorkflowResource
		if err := r.db.Where("user_id = ? AND resource_id IN ?", userID, resourceIDs).Find(&refs).Error; err != nil {
			return snapshot, err
		}
		for _, ref := range refs {
			snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "可复用工作流", ID: ref.OwnerID, Title: "工作流模板或运行结果", ResourceID: ref.ResourceID})
			delete(remaining, ref.ResourceID)
		}
	}

	var coverProjects []model.Project
	if err := r.db.Select("id", "name", "cover_resource_id").Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).Find(&coverProjects).Error; err != nil {
		return snapshot, err
	}
	for _, project := range coverProjects {
		if project.CoverResourceID != "" && slices.Contains(resourceIDs, project.CoverResourceID) {
			snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "项目主图", ID: project.ID, Title: project.Name, ResourceID: project.CoverResourceID})
			delete(remaining, project.CoverResourceID)
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
		delete(remaining, representation.ResourceID)
	}

	var voices []model.VoiceProfile
	if err := r.db.Where("user_id = ? AND sample_resource_id IN ?", userID, resourceIDs).Find(&voices).Error; err != nil {
		return snapshot, err
	}
	for _, voice := range voices {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "声音", ID: voice.ID, Title: voice.Name, ResourceID: voice.SampleResourceID})
		delete(remaining, voice.SampleResourceID)
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
		delete(remaining, artifact.ResourceID)
	}

	libraryRefs, err := r.CanvasLibraryResourceReferences(userID, resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, libraryRefs...)
	pruneDirect(libraryRefs)

	if len(remaining) == 0 {
		return snapshot, nil
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
		if matched := assets.DocumentReferencedIDs(asset.PayloadJSON, remaining); len(matched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "素材", ID: asset.ID, Title: asset.Title, PrimaryJSON: asset.PayloadJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
			})
			pruneSet(matched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
		}
	}

	// Scan canvas_projects in small ID-ordered chunks and match in Go (SIMD) so
	// large multi-megabyte canvases yield SQLite's single connection every ~5ms
	// and already-matched resource IDs avoid redundant JSON parsing on later rows.
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
			if matched := assets.DocumentReferencedIDs(canvas.PayloadJSON, remaining); len(matched) > 0 {
				snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
					Kind: "画布", ID: canvas.ID, Title: canvas.Title, PrimaryJSON: canvas.PayloadJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
				})
				pruneSet(matched)
				if len(remaining) == 0 {
					return snapshot, nil
				}
			}
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
		primaryMatched := assets.DocumentReferencedIDs(run.StateJSON, remaining)
		secondaryMatched := assets.DocumentReferencedIDs(run.ApprovedOperationsJSON, remaining)
		if len(primaryMatched) > 0 || len(secondaryMatched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "创作会话", ID: run.ID, Title: "智能创作", PrimaryJSON: run.StateJSON, SecondaryJSON: run.ApprovedOperationsJSON,
				PrimaryMatchedIDs: assets.SortedIDs(primaryMatched), SecondaryMatchedIDs: assets.SortedIDs(secondaryMatched),
			})
			pruneSet(primaryMatched)
			pruneSet(secondaryMatched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		if matched := assets.DocumentReferencedIDs(submission.RequestJSON, remaining); len(matched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "创作执行项", ID: submission.ID, Title: submission.ItemKey, PrimaryJSON: submission.RequestJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
			})
			pruneSet(matched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		if matched := assets.DocumentReferencedIDs(project.StyleProfileJSON, remaining); len(matched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "项目", ID: project.ID, Title: project.Name, PrimaryJSON: project.StyleProfileJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
			})
			pruneSet(matched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		primaryMatched := assets.DocumentReferencedIDs(style.CoverURL, remaining)
		secondaryMatched := assets.DocumentReferencedIDs(style.ProfileJSON, remaining)
		if len(primaryMatched) > 0 || len(secondaryMatched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "风格", ID: style.ID, Title: style.Name, PrimaryJSON: style.CoverURL, SecondaryJSON: style.ProfileJSON,
				PrimaryMatchedIDs: assets.SortedIDs(primaryMatched), SecondaryMatchedIDs: assets.SortedIDs(secondaryMatched),
			})
			pruneSet(primaryMatched)
			pruneSet(secondaryMatched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		if matched := assets.DocumentReferencedIDs(version.PrimaryJSON, remaining); len(matched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "素材", ID: version.ID, Title: version.Title, PrimaryJSON: version.PrimaryJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
			})
			pruneSet(matched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		if matched := assets.DocumentReferencedIDs(candidate.PrimaryJSON, remaining); len(matched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "项目", ID: candidate.ID, Title: candidate.Title, PrimaryJSON: candidate.PrimaryJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
			})
			pruneSet(matched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		primaryMatched := assets.DocumentReferencedIDs(step.PrimaryJSON, remaining)
		secondaryMatched := assets.DocumentReferencedIDs(step.SecondaryJSON, remaining)
		if len(primaryMatched) > 0 || len(secondaryMatched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "工作流", ID: step.ID, Title: step.Title, PrimaryJSON: step.PrimaryJSON, SecondaryJSON: step.SecondaryJSON,
				PrimaryMatchedIDs: assets.SortedIDs(primaryMatched), SecondaryMatchedIDs: assets.SortedIDs(secondaryMatched),
			})
			pruneSet(primaryMatched)
			pruneSet(secondaryMatched)
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
		if matched := assets.DocumentReferencedIDs(artifact.PrimaryJSON, remaining); len(matched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "镜头产物", ID: artifact.ID, Title: artifact.Title, PrimaryJSON: artifact.PrimaryJSON, PrimaryMatchedIDs: assets.SortedIDs(matched),
			})
			pruneSet(matched)
			if len(remaining) == 0 {
				return snapshot, nil
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
		primaryMatched := assets.DocumentReferencedIDs(task.InputJSON, remaining)
		secondaryMatched := assets.DocumentReferencedIDs(task.ResultJSON, remaining)
		if len(primaryMatched) > 0 || len(secondaryMatched) > 0 {
			snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
				Kind: "任务", ID: task.ID, Title: task.Prompt, PrimaryJSON: task.InputJSON, SecondaryJSON: task.ResultJSON,
				PrimaryMatchedIDs: assets.SortedIDs(primaryMatched), SecondaryMatchedIDs: assets.SortedIDs(secondaryMatched),
				TaskStatus: task.Status,
			})
			pruneSet(primaryMatched)
			if excludingAssetID == "" || !isCompletedTaskStatus(task.Status) {
				pruneSet(secondaryMatched)
			}
			if len(remaining) == 0 {
				return snapshot, nil
			}
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
	type matchedTaskLog struct {
		row     model.TaskLog
		matched []string
	}
	var matchedLogs []matchedTaskLog
	var matchedLogRows []model.TaskLog
	for _, taskLog := range taskLogs {
		if matched := assets.DocumentReferencedIDs(taskLog.Payload, remaining); len(matched) > 0 {
			matchedLogs = append(matchedLogs, matchedTaskLog{row: taskLog, matched: assets.SortedIDs(matched)})
			matchedLogRows = append(matchedLogRows, taskLog)
			if excludingAssetID == "" {
				pruneSet(matched)
				if len(remaining) == 0 {
					break
				}
			}
		}
	}
	var results []model.Result
	if len(remaining) > 0 {
		resultQuery := applySQLiteReferenceFilter(
			r.db.Select("id", "task_id", "kind", "url", "payload").Where("user_id = ? AND (url <> '' OR payload <> '')", userID),
			"url", "payload",
		)
		if err := resultQuery.Find(&results).Error; err != nil {
			return snapshot, err
		}
	}
	type matchedResultItem struct {
		row       model.Result
		primary   []string
		secondary []string
	}
	var matchedResults []matchedResultItem
	var matchedResultRows []model.Result
	for _, result := range results {
		primaryMatched := assets.DocumentReferencedIDs(result.URL, remaining)
		secondaryMatched := assets.DocumentReferencedIDs(result.Payload, remaining)
		if len(primaryMatched) > 0 || len(secondaryMatched) > 0 {
			matchedResults = append(matchedResults, matchedResultItem{
				row: result, primary: assets.SortedIDs(primaryMatched), secondary: assets.SortedIDs(secondaryMatched),
			})
			matchedResultRows = append(matchedResultRows, result)
			if excludingAssetID == "" {
				pruneSet(primaryMatched)
				pruneSet(secondaryMatched)
				if len(remaining) == 0 {
					break
				}
			}
		}
	}
	if err := populateMissingTaskStatuses(r.db, userID, taskStatuses, matchedLogRows, matchedResultRows); err != nil {
		return snapshot, err
	}
	for _, entry := range matchedLogs {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
			Kind: "任务日志", ID: entry.row.ID, Title: entry.row.Message, PrimaryJSON: entry.row.Payload,
			PrimaryMatchedIDs: entry.matched, TaskStatus: taskStatuses[entry.row.TaskID],
		})
	}
	for _, entry := range matchedResults {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{
			Kind: "任务结果", ID: entry.row.ID, Title: entry.row.Kind, PrimaryJSON: entry.row.URL, SecondaryJSON: entry.row.Payload,
			PrimaryMatchedIDs: entry.primary, SecondaryMatchedIDs: entry.secondary, TaskStatus: taskStatuses[entry.row.TaskID],
		})
	}

	return snapshot, nil
}

func isCompletedTaskStatus(status model.TaskStatus) bool {
	switch status {
	case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
		return true
	default:
		return false
	}
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
