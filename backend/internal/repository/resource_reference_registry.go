package repository

import (
	"slices"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// referenceDocumentSource declaratively defines one JSON-bearing table that can
// hold resource references. Both ResourceReferenceSnapshot and transactional
// deletion guards (DeleteDetachedResources / DeleteAssetAndResources) iterate
// this single registry so snapshot and guard coverage cannot drift apart.
type referenceDocumentSource struct {
	name           string
	kind           string
	table          string
	requiredTables []any
	joins          []string
	idCol          string
	titleExpr      string
	taskIDCol      string
	taskStatusCol  string
	primaryCol     string
	secondaryCol   string
	userCol        string
	excludeAsset   bool
	extraWhere     string
	chunkSize      int
	useSQLFilter   bool
	isTaskTable    bool
	isTaskOutput   bool
}

var referenceDocumentSources = []referenceDocumentSource{
	{
		name:           "assets",
		kind:           "素材",
		table:          "assets",
		requiredTables: []any{&model.Asset{}},
		idCol:          "assets.id",
		titleExpr:      "assets.title",
		primaryCol:     "assets.payload_json",
		userCol:        "assets.user_id",
		excludeAsset:   true,
		useSQLFilter:   true,
	},
	{
		name:           "canvas_projects",
		kind:           "画布",
		table:          "canvas_projects",
		requiredTables: []any{&model.CanvasProject{}},
		idCol:          "canvas_projects.id",
		titleExpr:      "canvas_projects.title",
		primaryCol:     "canvas_projects.payload_json",
		userCol:        "canvas_projects.user_id",
		chunkSize:      2,
		useSQLFilter:   false,
	},
	{
		name:           "creation_runs",
		kind:           "创作会话",
		table:          "creation_runs",
		requiredTables: []any{&model.CreationRun{}},
		idCol:          "creation_runs.id",
		titleExpr:      "'智能创作'",
		primaryCol:     "creation_runs.state_json",
		secondaryCol:   "creation_runs.approved_operations_json",
		userCol:        "creation_runs.user_id",
		useSQLFilter:   true,
	},
	{
		name:           "creation_submissions",
		kind:           "创作执行项",
		table:          "creation_submissions",
		requiredTables: []any{&model.CreationSubmission{}},
		idCol:          "creation_submissions.id",
		titleExpr:      "creation_submissions.item_key",
		primaryCol:     "creation_submissions.request_json",
		userCol:        "creation_submissions.user_id",
		extraWhere:     "creation_submissions.revoked_at IS NULL",
		useSQLFilter:   true,
	},
	{
		name:           "projects_style",
		kind:           "项目",
		table:          "projects",
		requiredTables: []any{&model.Project{}},
		idCol:          "projects.id",
		titleExpr:      "projects.name",
		primaryCol:     "projects.style_profile_json",
		userCol:        "projects.user_id",
		useSQLFilter:   true,
	},
	{
		name:           "style_profiles",
		kind:           "风格",
		table:          "style_profiles",
		requiredTables: []any{&model.StyleProfile{}},
		idCol:          "style_profiles.id",
		titleExpr:      "style_profiles.name",
		primaryCol:     "style_profiles.cover_url",
		secondaryCol:   "style_profiles.profile_json",
		userCol:        "style_profiles.user_id",
		useSQLFilter:   true,
	},
	{
		name:           "asset_versions",
		kind:           "素材",
		table:          "asset_versions",
		requiredTables: []any{&model.AssetVersion{}, &model.Asset{}},
		joins:          []string{"JOIN assets ON assets.id = asset_versions.asset_id"},
		idCol:          "asset_versions.id",
		titleExpr:      "assets.title",
		primaryCol:     "asset_versions.definition_json",
		userCol:        "assets.user_id",
		excludeAsset:   true,
		useSQLFilter:   true,
	},
	{
		name:           "project_asset_candidates",
		kind:           "项目",
		table:          "project_asset_candidates",
		requiredTables: []any{&model.ProjectAssetCandidate{}, &model.Project{}},
		joins:          []string{"JOIN projects ON projects.id = project_asset_candidates.project_id"},
		idCol:          "project_asset_candidates.id",
		titleExpr:      "projects.name",
		primaryCol:     "project_asset_candidates.details_json",
		userCol:        "projects.user_id",
		useSQLFilter:   true,
	},
	{
		name:           "workflow_step_instances",
		kind:           "工作流",
		table:          "workflow_step_instances",
		requiredTables: []any{&model.WorkflowStepInstance{}, &model.WorkflowInstance{}, &model.Project{}},
		joins: []string{
			"JOIN workflow_instances ON workflow_instances.id = workflow_step_instances.workflow_instance_id",
			"JOIN projects ON projects.id = workflow_instances.project_id",
		},
		idCol:        "workflow_step_instances.id",
		titleExpr:    "workflow_step_instances.name",
		primaryCol:   "workflow_step_instances.input_json",
		secondaryCol: "workflow_step_instances.output_json",
		userCol:      "projects.user_id",
		useSQLFilter: true,
	},
	{
		name:           "shot_artifacts_metadata",
		kind:           "镜头产物",
		table:          "shot_artifacts",
		requiredTables: []any{&model.ShotArtifact{}, &model.Shot{}, &model.Project{}},
		joins: []string{
			"JOIN shots ON shots.id = shot_artifacts.shot_id",
			"JOIN projects ON projects.id = shots.project_id",
		},
		idCol:        "shot_artifacts.id",
		titleExpr:    "shots.title",
		primaryCol:   "shot_artifacts.metadata_json",
		userCol:      "projects.user_id",
		useSQLFilter: true,
	},
	{
		name:           "tasks",
		kind:           "任务",
		table:          "tasks",
		requiredTables: []any{&model.Task{}},
		idCol:          "tasks.id",
		titleExpr:      "tasks.prompt",
		taskStatusCol:  "tasks.status",
		primaryCol:     "tasks.input_json",
		secondaryCol:   "tasks.result_json",
		userCol:        "tasks.user_id",
		chunkSize:      500,
		useSQLFilter:   true,
		isTaskTable:    true,
	},
	{
		name:           "task_logs",
		kind:           "任务日志",
		table:          "task_logs",
		requiredTables: []any{&model.TaskLog{}},
		idCol:          "task_logs.id",
		titleExpr:      "task_logs.message",
		taskIDCol:      "task_logs.task_id",
		primaryCol:     "task_logs.payload",
		userCol:        "task_logs.user_id",
		chunkSize:      1000,
		useSQLFilter:   true,
		isTaskOutput:   true,
	},
	{
		name:           "results",
		kind:           "任务结果",
		table:          "results",
		requiredTables: []any{&model.Result{}},
		idCol:          "results.id",
		titleExpr:      "results.kind",
		taskIDCol:      "results.task_id",
		primaryCol:     "results.url",
		secondaryCol:   "results.payload",
		userCol:        "results.user_id",
		chunkSize:      500,
		useSQLFilter:   true,
		isTaskOutput:   true,
	},
}

// collectDirectResourceReferences queries all indexed direct-reference tables
// from one shared implementation used by ResourceReferenceSnapshot,
// DeleteDetachedResources (always executed even on the watermark fast path),
// and DeleteAssetAndResources. Direct FK tables use LEFT JOIN or parent-free
// predicates so orphaned rows whose parent record is missing can never lose
// their underlying resource.
func collectDirectResourceReferences(db *gorm.DB, userID string, excludingAssetID string, resourceIDs []string, includeCanvasHistory bool, stopOnFirst bool) ([]ResourceDirectReference, error) {
	var excluded []string
	if excludingAssetID != "" {
		excluded = []string{excludingAssetID}
	}
	return collectDirectResourceReferencesExcluding(db, userID, excluded, resourceIDs, includeCanvasHistory, stopOnFirst)
}

func collectDirectResourceReferencesExcluding(db *gorm.DB, userID string, excludingAssetIDs []string, resourceIDs []string, includeCanvasHistory bool, stopOnFirst bool) ([]ResourceDirectReference, error) {
	if len(resourceIDs) == 0 {
		return nil, nil
	}
	var refs []ResourceDirectReference
	add := func(items ...ResourceDirectReference) bool {
		refs = append(refs, items...)
		return stopOnFirst && len(refs) > 0
	}

	if includeCanvasHistory && hasRequiredTables(db, []any{&model.CanvasSnapshotResource{}, &model.CanvasSnapshot{}}) {
		history, err := New(db).CanvasHistoryResourceReferences(resourceIDs)
		if err != nil {
			return nil, err
		}
		if add(history...) {
			return refs, nil
		}
	}

	exports, err := New(db).ProjectExportResourceReferences(userID, resourceIDs)
	if err != nil {
		return nil, err
	}
	if add(exports...) {
		return refs, nil
	}

	if db.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
		var workflowRefs []model.CanvasWorkflowResource
		if err := db.Where("user_id = ? AND resource_id IN ?", userID, resourceIDs).Find(&workflowRefs).Error; err != nil {
			return nil, err
		}
		for _, ref := range workflowRefs {
			if add(ResourceDirectReference{Kind: "可复用工作流", ID: ref.OwnerID, Title: "工作流模板或运行结果", ResourceID: ref.ResourceID}) {
				return refs, nil
			}
		}
	}

	if db.Migrator().HasTable(&model.Project{}) {
		var coverProjects []model.Project
		if err := db.Select("id", "name", "cover_resource_id").Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).Find(&coverProjects).Error; err != nil {
			return nil, err
		}
		for _, project := range coverProjects {
			if project.CoverResourceID != "" && slices.Contains(resourceIDs, project.CoverResourceID) {
				if add(ResourceDirectReference{Kind: "项目主图", ID: project.ID, Title: project.Name, ResourceID: project.CoverResourceID}) {
					return refs, nil
				}
			}
		}
	}

	type joinedDirectRef struct {
		ID         string
		Title      string
		ResourceID string
	}
	if db.Migrator().HasTable(&model.AssetRepresentation{}) {
		var representations []joinedDirectRef
		q := db.Table("asset_representations")
		if hasRequiredTables(db, []any{&model.AssetVersion{}, &model.Asset{}}) {
			q = q.Select("asset_representations.id, COALESCE(assets.title, '') AS title, asset_representations.resource_id").
				Joins("LEFT JOIN asset_versions ON asset_versions.id = asset_representations.asset_version_id").
				Joins("LEFT JOIN assets ON assets.id = asset_versions.asset_id").
				Where("asset_representations.resource_id IN ?", resourceIDs)
			if len(excludingAssetIDs) > 0 {
				q = q.Where("(assets.id IS NULL OR assets.id NOT IN ?)", excludingAssetIDs)
			}
		} else {
			q = q.Select("asset_representations.id, '' AS title, asset_representations.resource_id").
				Where("asset_representations.resource_id IN ?", resourceIDs)
		}
		if err := q.Scan(&representations).Error; err != nil {
			return nil, err
		}
		for _, rep := range representations {
			if add(ResourceDirectReference{Kind: "素材", ID: rep.ID, Title: rep.Title, ResourceID: rep.ResourceID}) {
				return refs, nil
			}
		}
	}

	if db.Migrator().HasTable(&model.VoiceProfile{}) {
		var voices []model.VoiceProfile
		if err := db.Where("sample_resource_id IN ?", resourceIDs).Find(&voices).Error; err != nil {
			return nil, err
		}
		for _, voice := range voices {
			if add(ResourceDirectReference{Kind: "声音", ID: voice.ID, Title: voice.Name, ResourceID: voice.SampleResourceID}) {
				return refs, nil
			}
		}
	}

	if db.Migrator().HasTable(&model.ShotArtifact{}) {
		var artifacts []joinedDirectRef
		q := db.Table("shot_artifacts")
		if db.Migrator().HasTable(&model.Shot{}) {
			q = q.Select("shot_artifacts.id, COALESCE(shots.title, '') AS title, shot_artifacts.resource_id").
				Joins("LEFT JOIN shots ON shots.id = shot_artifacts.shot_id").
				Where("shot_artifacts.resource_id IN ?", resourceIDs)
		} else {
			q = q.Select("shot_artifacts.id, '' AS title, shot_artifacts.resource_id").
				Where("shot_artifacts.resource_id IN ?", resourceIDs)
		}
		if err := q.Scan(&artifacts).Error; err != nil {
			return nil, err
		}
		for _, artifact := range artifacts {
			if add(ResourceDirectReference{Kind: "镜头产物", ID: artifact.ID, Title: artifact.Title, ResourceID: artifact.ResourceID}) {
				return refs, nil
			}
		}
	}

	libraryRefs, err := New(db).CanvasLibraryResourceReferences(userID, resourceIDs)
	if err != nil {
		return nil, err
	}
	if add(libraryRefs...) {
		return refs, nil
	}

	return refs, nil
}

type documentScanOptions struct {
	userID                   string
	excludingAssetID         string
	excludingAssetIDs        []string
	remaining                map[string]struct{}
	skipCompletedTaskOutputs bool
	stopOnFirst              bool
	deletedOutputMatcher     *deletedGenerationOutputMatcher
}

type scannedDocumentRow struct {
	ID            string
	Title         string
	TaskID        string
	TaskStatus    model.TaskStatus
	PrimaryJSON   string
	SecondaryJSON string
}

// scanReferenceDocuments executes every registered JSON document source once.
// When stopOnFirst is true it returns ErrResourceCleanupStillReferenced on the
// first blocking match; otherwise it appends matched documents to *out and
// prunes unconditionally retained IDs from opts.remaining.
func scanReferenceDocuments(db *gorm.DB, opts documentScanOptions, out *[]ResourceReferenceDocument) error {
	if len(opts.remaining) == 0 {
		return nil
	}
	taskStatuses := map[string]model.TaskStatus{}
	for _, src := range referenceDocumentSources {
		if len(opts.remaining) == 0 {
			return nil
		}
		if !hasRequiredTables(db, src.requiredTables) {
			continue
		}
		if err := scanReferenceDocumentSource(db, src, opts, taskStatuses, out); err != nil {
			return err
		}
	}
	return nil
}

func scanReferenceDocumentSource(db *gorm.DB, src referenceDocumentSource, opts documentScanOptions, taskStatuses map[string]model.TaskStatus, out *[]ResourceReferenceDocument) error {
	selectExpr := src.idCol + " AS id, " + src.titleExpr + " AS title, " + src.primaryCol + " AS primary_json"
	if src.secondaryCol != "" {
		selectExpr += ", " + src.secondaryCol + " AS secondary_json"
	}
	if src.taskIDCol != "" {
		selectExpr += ", " + src.taskIDCol + " AS task_id"
	}
	if src.taskStatusCol != "" {
		selectExpr += ", " + src.taskStatusCol + " AS task_status"
	}

	buildQuery := func(minID, maxID string) *gorm.DB {
		q := db.Table(src.table).Select(selectExpr)
		for _, joinClause := range src.joins {
			q = q.Joins(joinClause)
		}
		if minID != "" && maxID != "" {
			if db.Dialector != nil && db.Dialector.Name() == "sqlite" {
				// Unary '+' suppresses the single-column user_id index so SQLite
				// runs an O(chunkSize) primary-key range scan instead of
				// re-scanning every row belonging to userID on each chunk.
				q = q.Where("+"+src.userCol+" = ?", opts.userID).
					Where(src.idCol+" >= ? AND "+src.idCol+" <= ?", minID, maxID)
			} else {
				q = q.Where(src.userCol+" = ?", opts.userID).
					Where(src.idCol+" >= ? AND "+src.idCol+" <= ?", minID, maxID)
			}
		} else {
			q = q.Where(src.userCol+" = ?", opts.userID)
		}
		if src.excludeAsset {
			if len(opts.excludingAssetIDs) > 0 {
				q = q.Where("assets.id NOT IN ?", opts.excludingAssetIDs)
			} else if opts.excludingAssetID != "" {
				q = q.Where("assets.id <> ?", opts.excludingAssetID)
			}
		}
		if src.extraWhere != "" {
			q = q.Where(src.extraWhere)
		}
		if src.secondaryCol != "" {
			q = q.Where("(" + src.primaryCol + " <> '' OR " + src.secondaryCol + " <> '')")
		} else {
			q = q.Where(src.primaryCol + " <> ''")
		}
		if src.useSQLFilter {
			if src.secondaryCol != "" {
				q = applySQLiteReferenceFilter(q, src.primaryCol, src.secondaryCol)
			} else {
				q = applySQLiteReferenceFilter(q, src.primaryCol)
			}
		}
		return q
	}

	processRows := func(rows []scannedDocumentRow) error {
		if len(rows) == 0 {
			return nil
		}
		if src.isTaskOutput {
			type matchedOutput struct {
				row       scannedDocumentRow
				primary   map[string]struct{}
				secondary map[string]struct{}
			}
			var matched []matchedOutput
			var taskIDs []string
			for _, row := range rows {
				primary := assets.DocumentReferencedIDs(row.PrimaryJSON, opts.remaining)
				secondary := assets.DocumentReferencedIDs(row.SecondaryJSON, opts.remaining)
				if len(primary) == 0 && len(secondary) == 0 {
					continue
				}
				matched = append(matched, matchedOutput{row: row, primary: primary, secondary: secondary})
				if row.TaskID != "" {
					taskIDs = append(taskIDs, row.TaskID)
				}
			}
			if len(matched) == 0 {
				return nil
			}
			if err := populateMissingTaskStatusesByIDs(db, opts.userID, taskStatuses, taskIDs); err != nil {
				return err
			}
			hasExcludingAsset := opts.excludingAssetID != "" || len(opts.excludingAssetIDs) > 0
			for _, item := range matched {
				status := taskStatuses[item.row.TaskID]
				retainedCompletedOutput := false
				if src.name == "results" && isCompletedTaskStatus(status) && opts.deletedOutputMatcher != nil {
					retained, err := isRetainedCompletedGenerationOutput(db, opts.userID, item.row.Title, item.row.TaskID, item.row.SecondaryJSON, opts.deletedOutputMatcher)
					if err != nil {
						return err
					}
					retainedCompletedOutput = retained
				}
				if opts.stopOnFirst {
					if !opts.skipCompletedTaskOutputs || !isCompletedTaskStatus(status) || retainedCompletedOutput {
						return ErrResourceCleanupStillReferenced
					}
					continue
				}
				*out = append(*out, ResourceReferenceDocument{
					Kind:                    src.kind,
					ID:                      item.row.ID,
					Title:                   item.row.Title,
					TaskID:                  item.row.TaskID,
					PrimaryJSON:             item.row.PrimaryJSON,
					SecondaryJSON:           item.row.SecondaryJSON,
					PrimaryMatchedIDs:       assets.SortedIDs(item.primary),
					SecondaryMatchedIDs:     assets.SortedIDs(item.secondary),
					TaskStatus:              status,
					RetainedCompletedOutput: retainedCompletedOutput,
				})
				if !hasExcludingAsset || !isCompletedTaskStatus(status) || retainedCompletedOutput {
					for id := range item.primary {
						delete(opts.remaining, id)
					}
					for id := range item.secondary {
						delete(opts.remaining, id)
					}
				}
			}
			return nil
		}

		hasExcludingAsset := opts.excludingAssetID != "" || len(opts.excludingAssetIDs) > 0
		for _, row := range rows {
			if src.isTaskTable {
				taskStatuses[row.ID] = row.TaskStatus
			}
			primary := assets.DocumentReferencedIDs(row.PrimaryJSON, opts.remaining)
			var secondary map[string]struct{}
			if row.SecondaryJSON != "" && (!src.isTaskTable || !opts.stopOnFirst || !opts.skipCompletedTaskOutputs || !isCompletedTaskStatus(row.TaskStatus)) {
				secondary = assets.DocumentReferencedIDs(row.SecondaryJSON, opts.remaining)
			}
			if len(primary) == 0 && len(secondary) == 0 {
				continue
			}
			if opts.stopOnFirst {
				return ErrResourceCleanupStillReferenced
			}
			*out = append(*out, ResourceReferenceDocument{
				Kind:                src.kind,
				ID:                  row.ID,
				Title:               row.Title,
				PrimaryJSON:         row.PrimaryJSON,
				SecondaryJSON:       row.SecondaryJSON,
				PrimaryMatchedIDs:   assets.SortedIDs(primary),
				SecondaryMatchedIDs: assets.SortedIDs(secondary),
				TaskStatus:          row.TaskStatus,
			})
			for id := range primary {
				delete(opts.remaining, id)
			}
			if !src.isTaskTable || !hasExcludingAsset || !isCompletedTaskStatus(row.TaskStatus) {
				for id := range secondary {
					delete(opts.remaining, id)
				}
			}
			if len(opts.remaining) == 0 {
				return nil
			}
		}
		return nil
	}

	if src.chunkSize > 0 {
		var allIDs []string
		if err := db.Table(src.table).Where(src.userCol+" = ?", opts.userID).Order(src.idCol+" ASC").Pluck(src.idCol, &allIDs).Error; err != nil {
			return err
		}
		for start := 0; start < len(allIDs) && len(opts.remaining) > 0; start += src.chunkSize {
			end := min(start+src.chunkSize, len(allIDs))
			var rows []scannedDocumentRow
			if err := buildQuery(allIDs[start], allIDs[end-1]).Scan(&rows).Error; err != nil {
				return err
			}
			if err := processRows(rows); err != nil {
				return err
			}
		}
		return nil
	}

	var rows []scannedDocumentRow
	if err := buildQuery("", "").Scan(&rows).Error; err != nil {
		return err
	}
	return processRows(rows)
}

func guardReferenceDocuments(tx *gorm.DB, userID string, excludingAssetID string, resourceIDs []string, skipCompletedTaskOutputs bool) error {
	var excluded []string
	if excludingAssetID != "" {
		excluded = []string{excludingAssetID}
	}
	return guardReferenceDocumentsExcluding(tx, userID, excluded, nil, resourceIDs, skipCompletedTaskOutputs)
}

func guardReferenceDocumentsExcluding(tx *gorm.DB, userID string, excludingAssetIDs []string, deletedAssets []model.Asset, resourceIDs []string, skipCompletedTaskOutputs bool) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	remaining := make(map[string]struct{}, len(resourceIDs))
	for _, id := range resourceIDs {
		remaining[id] = struct{}{}
	}
	var outputMatcher *deletedGenerationOutputMatcher
	if len(deletedAssets) > 0 {
		outputMatcher = newDeletedGenerationOutputMatcher(deletedAssets)
	}
	return scanReferenceDocuments(tx, documentScanOptions{
		userID:                   userID,
		excludingAssetIDs:        excludingAssetIDs,
		remaining:                remaining,
		skipCompletedTaskOutputs: skipCompletedTaskOutputs,
		stopOnFirst:              true,
		deletedOutputMatcher:     outputMatcher,
	}, nil)
}

func guardAssetDeletionReferencesExcluding(tx *gorm.DB, userID string, excludingAssetIDs []string, deletedAssets []model.Asset, resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	// Canvas history references are verified right before this by
	// RequireNoCanvasHistoryReferences so DeleteAssetAndResources keeps its
	// dedicated ErrCanvasHistoryResourceReferenced error contract.
	refs, err := collectDirectResourceReferencesExcluding(tx, userID, excludingAssetIDs, resourceIDs, false, true)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return ErrResourceCleanupStillReferenced
	}
	return guardReferenceDocumentsExcluding(tx, userID, excludingAssetIDs, deletedAssets, resourceIDs, true)
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

func hasRequiredTables(db *gorm.DB, models []any) bool {
	migrator := db.Migrator()
	for _, item := range models {
		if !migrator.HasTable(item) {
			return false
		}
	}
	return true
}

func isCompletedTaskStatus(status model.TaskStatus) bool {
	switch status {
	case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
		return true
	default:
		return false
	}
}

func populateMissingTaskStatusesByIDs(db *gorm.DB, userID string, statuses map[string]model.TaskStatus, taskIDs []string) error {
	missing := make([]string, 0)
	seen := map[string]struct{}{}
	for _, taskID := range taskIDs {
		if taskID == "" {
			continue
		}
		if _, ok := statuses[taskID]; ok {
			continue
		}
		if _, dup := seen[taskID]; dup {
			continue
		}
		seen[taskID] = struct{}{}
		missing = append(missing, taskID)
	}
	if len(missing) == 0 || !db.Migrator().HasTable(&model.Task{}) {
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
