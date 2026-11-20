package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"

	"infinite-canvas/backend/internal/kernel"

	"gorm.io/gorm"
)

const interruptedFileUploadMessage = "上传已中断，请重新选择文件上传"
const openRecoveryPlaceholderError = "正在从任务中心恢复生成状态..."

// DocumentPatch is a node/edge-level delta commit from the local desktop UI.
// Applying only touched entities on top of the latest SQLite document avoids
// whole-document revision collisions with parallel background task bindings
// and external agent writes.
type DocumentPatch struct {
	BaseRevision         int64                     `json:"baseRevision"`
	UpsertNodes          []map[string]any          `json:"upsertNodes,omitempty"`
	DeleteNodeIDs        []string                  `json:"deleteNodeIds,omitempty"`
	UpsertConnections    []map[string]any          `json:"upsertConnections,omitempty"`
	DeleteConnectionIDs  []string                  `json:"deleteConnectionIds,omitempty"`
	UpsertChatSessions   []map[string]any          `json:"upsertChatSessions,omitempty"`
	DeleteChatSessionIDs []string                  `json:"deleteChatSessionIds,omitempty"`
	Fields               map[string]any            `json:"fields,omitempty"`
	ExpectedNodes        map[string]map[string]any `json:"expectedNodes,omitempty"`
	ExpectedConnections  map[string]map[string]any `json:"expectedConnections,omitempty"`
	ExpectedChatSessions map[string]map[string]any `json:"expectedChatSessions,omitempty"`
	ExpectedFields       map[string]any            `json:"expectedFields,omitempty"`
	ForceHistorySnapshot bool                      `json:"forceHistorySnapshot,omitempty"`
}

// DocumentPatchResult reports the authoritative saved state after applying a delta.
type DocumentPatchResult struct {
	Summary            UserDataSummary `json:"summary"`
	ServerAdvanced     bool            `json:"serverAdvanced"`
	MediaPreserved     bool            `json:"mediaPreserved"`
	SnapshotCaptured   bool            `json:"snapshotCaptured"`
	MergedFromRevision int64           `json:"mergedFromRevision"`
	Document           json.RawMessage `json:"document,omitempty"`
}

// Matches web/src/lib/canvas/canvas-node-metadata-contract.ts GENERATION_BIND_METADATA_KEYS
// plus canvas-level output metadata (hasAudio, videoPreview, outputParameterWarning,
// smartEraseSubtitles, storyboard).
var boundGenerationOutputFields = []string{
	"content", "storageKey", "assetId",
	"imageHistory", "mimeType", "bytes",
	"naturalWidth", "naturalHeight", "durationMs", "hasAudio", "videoPreview",
	"outputParameterWarning", "nodeRole", "resultOrigin", "status",
	"smartEraseSubtitles", "storyboard",
	"taskType", "taskOutcome",
	"taskClientOperationId", "taskClientOperationInput", "taskClientOperationTerminal",
	"generationSubmissionState", "retryOf", "attemptGroupId",
	"taskProvider", "taskStatus", "taskProgress", "taskStage",
	"taskCreatedAt", "taskStartedAt", "taskCompletedAt", "taskDurationMs",
	"taskErrorCode", "taskProviderRequestId", "taskProviderCancelStatus", "taskOfficialStatus",
	"taskReceiptRecorded", "taskUpdatedAt", "generationEffectKeys",
}

// Matches web/src/lib/canvas/canvas-node-metadata-contract.ts GENERATION_ERROR_METADATA_KEYS
// plus legacy "error" and upload overlay flags.
var boundGenerationClearedErrorFields = []string{
	"error", "errorDetails",
	"generationErrorCode", "generationErrorSummary", "generationProviderCode",
	"taskFailureDiagnostics", "generationFailure", "generationPreflightError",
	"taskOutcomeSource", "resourceReloadAvailable",
	"failedPromptFingerprint", "failedInputFingerprint", "processingLabel",
	"fileUpload", "fileUploadProgress",
}

// Matches web/src/lib/canvas/canvas-node-metadata-contract.ts UPLOAD_SETTLEMENT_METADATA_KEYS
// (excluding transient upload overlay keys cleared on settlement).
var settledUploadOutputFields = []string{
	"content", "storageKey", "assetId", "status",
	"bytes", "mimeType", "naturalWidth", "naturalHeight",
	"durationMs", "hasAudio", "videoPreview", "outputParameterWarning",
	"nodeRole", "resultOrigin", "fileUploadAttemptId",
}

// PatchUserCanvasDocument merges an entity-level UI delta onto the latest SQLite
// canvas document. Retries internal CAS contention atomically so disjoint edits
// never return 409 to the UI, and forces a recoverable history snapshot whenever
// an edit genuinely overlaps an entity changed on the server.
func (s *Service) PatchUserCanvasDocument(userID, canvasID string, patch DocumentPatch) (DocumentPatchResult, error) {
	canvasID = strings.TrimSpace(canvasID)
	if canvasID == "" {
		return DocumentPatchResult{}, kernel.BadAuthRequest("画布 ID 必填")
	}
	if patch.BaseRevision < 0 {
		return DocumentPatchResult{}, kernel.BadAuthRequest("画布版本无效")
	}
	var lastErr error
	for attempt := 0; attempt < bindRevisionAttempts; attempt++ {
		result, err := s.patchUserCanvasDocumentOnce(userID, canvasID, patch)
		if err == nil {
			return result, nil
		}
		lastErr = err
		if !isCanvasRevisionConflict(err) {
			return DocumentPatchResult{}, err
		}
	}
	if lastErr == nil {
		lastErr = canvasRevisionConflict()
	}
	return DocumentPatchResult{}, lastErr
}

func (s *Service) patchUserCanvasDocumentOnce(userID, canvasID string, patch DocumentPatch) (DocumentPatchResult, error) {
	existing, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return DocumentPatchResult{}, kernel.NewAppError(http.StatusNotFound, "画布不存在或无权访问")
	}
	if err != nil {
		return DocumentPatchResult{}, err
	}
	currentRaw, err := canvasProjectPayload(*existing)
	if err != nil {
		return DocumentPatchResult{}, err
	}
	var currentDoc map[string]any
	if err := json.Unmarshal(currentRaw, &currentDoc); err != nil {
		return DocumentPatchResult{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	if currentDoc == nil {
		currentDoc = map[string]any{}
	}
	var doc map[string]any
	if err := json.Unmarshal(currentRaw, &doc); err != nil {
		return DocumentPatchResult{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	if doc == nil {
		doc = map[string]any{}
	}

	serverAdvanced := existing.Revision > patch.BaseRevision
	mediaPreserved := false
	overlapped := patch.ForceHistorySnapshot

	// 1. Nodes: apply explicit deletions and upserts by ID while keeping untouched server nodes.
	deleteNodeSet := toIDSet(patch.DeleteNodeIDs)
	nodes := canvasDocNodes(doc)
	existingByID := make(map[string]map[string]any, len(nodes))
	orderedIDs := make([]string, 0, len(nodes)+len(patch.UpsertNodes))
	for _, raw := range nodes {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(nodeString(item, "id"))
		if id == "" {
			continue
		}
		if deleteNodeSet[id] {
			if expectedBase, hasExpected := patch.ExpectedNodes[id]; hasExpected {
				if !sameNormalizedNode(item, expectedBase) {
					overlapped = true
				}
			} else if serverAdvanced && nodeHasBoundOutput(item) {
				overlapped = true
			}
			continue
		}
		existingByID[id] = item
		orderedIDs = append(orderedIDs, id)
	}
	for _, incoming := range patch.UpsertNodes {
		if incoming == nil {
			continue
		}
		id := strings.TrimSpace(nodeString(incoming, "id"))
		if id == "" || deleteNodeSet[id] {
			continue
		}
		cloned := cloneNode(incoming)
		prev, exists := existingByID[id]
		if !exists {
			// If client expected this node to exist, the server deleted it since baseRevision.
			if _, hadExpected := patch.ExpectedNodes[id]; hadExpected {
				overlapped = true
			}
			existingByID[id] = cloned
			orderedIDs = append(orderedIDs, id)
			continue
		}
		mergedNode, preserved := mergePatchedNode(prev, cloned)
		if preserved {
			mediaPreserved = true
			overlapped = true
		} else if expectedBase, hasExpected := patch.ExpectedNodes[id]; hasExpected {
			if !sameNormalizedNode(prev, expectedBase) && !sameNormalizedNode(prev, mergedNode) {
				overlapped = true
			}
		} else if serverAdvanced && !reflect.DeepEqual(prev, mergedNode) {
			overlapped = true
		}
		existingByID[id] = mergedNode
	}
	nextNodes := make([]any, 0, len(orderedIDs))
	for _, id := range orderedIDs {
		if item, ok := existingByID[id]; ok {
			nextNodes = append(nextNodes, item)
		}
	}
	doc["nodes"] = nextNodes

	// 2. Connections: drop deleted edges and edges dangling from deleted nodes, then upsert.
	deleteEdgeSet := toIDSet(patch.DeleteConnectionIDs)
	if len(deleteNodeSet) > 0 || len(deleteEdgeSet) > 0 || len(patch.UpsertConnections) > 0 {
		mergedConns, connOverlapped := mergeEntitySliceWithOverlap(
			doc["connections"],
			patch.UpsertConnections,
			patch.ExpectedConnections,
			serverAdvanced,
			func(item map[string]any) bool {
				id := strings.TrimSpace(nodeString(item, "id"))
				from := strings.TrimSpace(nodeString(item, "fromNodeId"))
				to := strings.TrimSpace(nodeString(item, "toNodeId"))
				return deleteEdgeSet[id] || deleteNodeSet[from] || deleteNodeSet[to]
			},
		)
		doc["connections"] = mergedConns
		if connOverlapped {
			overlapped = true
		}
	}

	// 3. Chat sessions: drop deleted and upsert touched sessions.
	if len(patch.DeleteChatSessionIDs) > 0 || len(patch.UpsertChatSessions) > 0 {
		deleteSessionSet := toIDSet(patch.DeleteChatSessionIDs)
		mergedChats, chatOverlapped := mergeEntitySliceWithOverlap(
			doc["chatSessions"],
			patch.UpsertChatSessions,
			patch.ExpectedChatSessions,
			serverAdvanced,
			func(item map[string]any) bool {
				return deleteSessionSet[strings.TrimSpace(nodeString(item, "id"))]
			},
		)
		doc["chatSessions"] = mergedChats
		if chatOverlapped {
			overlapped = true
		}
	}

	// 4. Top-level fields (never overwrite server-owned identity/timestamps/revision/viewport or entity lists).
	for key, value := range patch.Fields {
		switch key {
		case "id", "revision", "createdAt", "updatedAt", "remoteContentHash", "viewport", "nodes", "connections", "chatSessions":
			continue
		default:
			if expectedVal, hasExpected := patch.ExpectedFields[key]; hasExpected {
				if !samePatchValue(doc[key], expectedVal) && !samePatchValue(doc[key], value) {
					overlapped = true
				}
			} else if serverAdvanced && !samePatchValue(doc[key], value) {
				overlapped = true
			}
			if value == nil && key != "activeChatId" {
				delete(doc, key)
			} else {
				doc[key] = value
			}
		}
	}

	doc["id"] = canvasID
	doc["revision"] = existing.Revision
	delete(doc, "remoteContentHash")

	// Skip no-op patches (empty or filtered-only fields like viewport) without bumping revision.
	if sameEffectiveCanvasDoc(currentDoc, doc) {
		summary := UserDataSummary{
			ID:        existing.ID,
			Title:     existing.Title,
			CreatedAt: existing.CreatedAt,
			UpdatedAt: existing.UpdatedAt,
			Revision:  existing.Revision,
		}
		var docPayload json.RawMessage
		if serverAdvanced || mediaPreserved {
			docPayload = currentRaw
		}
		return DocumentPatchResult{
			Summary:            summary,
			ServerAdvanced:     serverAdvanced,
			MediaPreserved:     mediaPreserved,
			SnapshotCaptured:   false,
			MergedFromRevision: existing.Revision,
			Document:           docPayload,
		}, nil
	}

	mergedRaw, err := json.Marshal(doc)
	if err != nil {
		return DocumentPatchResult{}, err
	}
	mergedRaw, err = reconcileStoryboardDocument(currentRaw, mergedRaw)
	if err != nil {
		return DocumentPatchResult{}, err
	}

	reason := "automatic"
	if overlapped {
		reason = "before_merge"
	}
	summary, savedPayload, snapshotCaptured, err := s.upsertUserCanvasProjectAndPayloadWithCapture(userID, mergedRaw, nil, reason, serverAdvanced || mediaPreserved)
	if err != nil {
		return DocumentPatchResult{}, err
	}
	return DocumentPatchResult{
		Summary:            summary,
		ServerAdvanced:     serverAdvanced,
		MediaPreserved:     mediaPreserved,
		SnapshotCaptured:   snapshotCaptured,
		MergedFromRevision: existing.Revision,
		Document:           savedPayload,
	}, nil
}

func nodeHasBoundOutput(node map[string]any) bool {
	if NodeHasMedia(node) {
		return true
	}
	meta := nodeMetadata(node)
	if nodeString(meta, "status") != "success" {
		return false
	}
	if nodeString(meta, "content") != "" {
		return true
	}
	if _, hasStoryboard := meta["storyboard"].(map[string]any); hasStoryboard {
		return true
	}
	return false
}

// nodeUploadOverlayFlag recognizes both the production string metadata.fileUpload
// ("uploading", or "error" with interrupted upload overlay) and legacy map shapes.
func nodeUploadOverlayFlag(meta map[string]any) bool {
	if meta == nil {
		return false
	}
	if rawStr, ok := meta["fileUpload"].(string); ok {
		status := strings.ToLower(strings.TrimSpace(rawStr))
		if status == "uploading" || status == "pending" || status == "processing" {
			return true
		}
		if status == "error" && strings.TrimSpace(nodeString(meta, "errorDetails")) == interruptedFileUploadMessage {
			return true
		}
		return false
	}
	if rawMap, ok := meta["fileUpload"].(map[string]any); ok && rawMap != nil {
		status := strings.ToLower(strings.TrimSpace(nodeString(rawMap, "status")))
		return status == "uploading" || status == "pending" || status == "processing"
	}
	return false
}

// Mirrors web/src/lib/canvas/canvas-node-metadata-contract.ts:
// a node has settled media when it carries media AND either has status=="success"
// (even if a stale fileUpload flag was left behind, matching hasStaleSettledFileUploadFlag)
// or has no active upload overlay with status neither "loading" nor "error".
func nodeHasSettledUpload(node map[string]any) bool {
	if !NodeHasMedia(node) {
		return false
	}
	meta := nodeMetadata(node)
	status := nodeString(meta, "status")
	if status == "success" {
		return true
	}
	return !nodeUploadOverlayFlag(meta) && status != "loading" && status != "error"
}

// mergePatchedNode protects server-bound generation outputs (media, text, or
// storyboard) and settled uploads against stale in-flight UI overlays while
// keeping the user's own edits (position, size, title, prompt, etc.) on the node.
func mergePatchedNode(existing, incoming map[string]any) (map[string]any, bool) {
	existingMeta := nodeMetadata(existing)
	incomingMeta := nodeMetadata(incoming)

	// 1. Protect server-bound generation output for the same taskId.
	existingTaskID := nodeString(existingMeta, "taskId")
	incomingTaskID := nodeString(incomingMeta, "taskId")
	incomingStatus := nodeString(incomingMeta, "status")
	incomingStaleOverlay := incomingStatus == "loading" || incomingStatus == "error" || !nodeHasBoundOutput(incoming)
	if existingTaskID != "" && existingTaskID == incomingTaskID &&
		nodeString(existingMeta, "status") == "success" && nodeHasBoundOutput(existing) &&
		incomingStaleOverlay {
		merged := cloneNode(incoming)
		meta := nodeMetadata(merged)
		for _, key := range boundGenerationOutputFields {
			if value, ok := existingMeta[key]; ok {
				meta[key] = value
			} else {
				delete(meta, key)
			}
		}
		for _, key := range boundGenerationClearedErrorFields {
			delete(meta, key)
		}
		merged["metadata"] = meta
		return merged, true
	}

	// 2. Protect settled file upload (including nodes carrying a stale fileUpload flag)
	// against any active/interrupted upload overlay — including replacement upload
	// placeholders that keep old media with status omitted and a new fileUploadAttemptId —
	// until the new upload settles and clears fileUpload.
	incomingUploadingOverlay := nodeUploadOverlayFlag(incomingMeta) && !(NodeHasMedia(incoming) && incomingStatus == "success")
	if nodeHasSettledUpload(existing) && incomingUploadingOverlay {
		merged := cloneNode(incoming)
		meta := nodeMetadata(merged)
		for _, key := range settledUploadOutputFields {
			if value, ok := existingMeta[key]; ok {
				meta[key] = value
			} else {
				delete(meta, key)
			}
		}
		for _, key := range boundGenerationClearedErrorFields {
			delete(meta, key)
		}
		merged["metadata"] = meta
		return merged, true
	}

	return incoming, false
}

func stripNodeBookkeeping(node map[string]any) map[string]any {
	if node == nil {
		return nil
	}
	cleaned := cloneNode(node)
	delete(cleaned, "createdAt")
	delete(cleaned, "updatedAt")
	meta := nodeMetadata(cleaned)
	if meta != nil && nodeString(meta, "status") == "loading" && nodeString(meta, "errorDetails") == openRecoveryPlaceholderError {
		delete(meta, "errorDetails")
		cleaned["metadata"] = meta
	}
	return cleaned
}

func sameNormalizedNode(left, right map[string]any) bool {
	return reflect.DeepEqual(stripNodeBookkeeping(left), stripNodeBookkeeping(right))
}

func samePatchValue(left, right any) bool {
	if isPatchEmpty(left) && isPatchEmpty(right) {
		return true
	}
	return reflect.DeepEqual(left, right)
}

func isPatchEmpty(v any) bool {
	if v == nil {
		return true
	}
	switch x := v.(type) {
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	case map[string]any:
		return len(x) == 0
	default:
		return false
	}
}

func sameEffectiveCanvasDoc(left, right map[string]any) bool {
	ignored := map[string]bool{
		"revision":          true,
		"createdAt":         true,
		"updatedAt":         true,
		"viewport":          true,
		"remoteContentHash": true,
	}
	keys := make(map[string]struct{}, len(left)+len(right))
	for k := range left {
		if !ignored[k] {
			keys[k] = struct{}{}
		}
	}
	for k := range right {
		if !ignored[k] {
			keys[k] = struct{}{}
		}
	}
	for k := range keys {
		if !samePatchValue(left[k], right[k]) {
			return false
		}
	}
	return true
}

func mergeEntitySliceWithOverlap(
	raw any,
	upserts []map[string]any,
	expected map[string]map[string]any,
	serverAdvanced bool,
	shouldDrop func(map[string]any) bool,
) ([]any, bool) {
	items, _ := raw.([]any)
	byID := make(map[string]map[string]any, len(items)+len(upserts))
	order := make([]string, 0, len(items)+len(upserts))
	overlapped := false
	for _, entry := range items {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(nodeString(item, "id"))
		if id == "" {
			continue
		}
		if shouldDrop(item) {
			if expectedBase, hasExpected := expected[id]; hasExpected {
				if !reflect.DeepEqual(item, expectedBase) {
					overlapped = true
				}
			} else if serverAdvanced {
				overlapped = true
			}
			continue
		}
		byID[id] = item
		order = append(order, id)
	}
	for _, entry := range upserts {
		if entry == nil {
			continue
		}
		id := strings.TrimSpace(nodeString(entry, "id"))
		if id == "" || shouldDrop(entry) {
			continue
		}
		cloned := cloneNode(entry)
		prev, exists := byID[id]
		if !exists {
			if _, hadExpected := expected[id]; hadExpected {
				overlapped = true
			}
			order = append(order, id)
			byID[id] = cloned
			continue
		}
		if expectedBase, hasExpected := expected[id]; hasExpected {
			if !reflect.DeepEqual(prev, expectedBase) && !reflect.DeepEqual(prev, cloned) {
				overlapped = true
			}
		} else if serverAdvanced && !reflect.DeepEqual(prev, cloned) {
			overlapped = true
		}
		byID[id] = cloned
	}
	out := make([]any, 0, len(order))
	for _, id := range order {
		if item, ok := byID[id]; ok {
			out = append(out, item)
		}
	}
	return out, overlapped
}

func toIDSet(ids []string) map[string]bool {
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			set[trimmed] = true
		}
	}
	return set
}
