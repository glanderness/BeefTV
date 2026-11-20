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

// DocumentPatch is a node/edge-level delta commit from the local desktop UI.
// Applying only touched entities on top of the latest SQLite document avoids
// whole-document revision collisions with parallel background task bindings
// and external agent writes.
type DocumentPatch struct {
	BaseRevision         int64            `json:"baseRevision"`
	UpsertNodes          []map[string]any `json:"upsertNodes,omitempty"`
	DeleteNodeIDs        []string         `json:"deleteNodeIds,omitempty"`
	UpsertConnections    []map[string]any `json:"upsertConnections,omitempty"`
	DeleteConnectionIDs  []string         `json:"deleteConnectionIds,omitempty"`
	UpsertChatSessions   []map[string]any `json:"upsertChatSessions,omitempty"`
	DeleteChatSessionIDs []string         `json:"deleteChatSessionIds,omitempty"`
	Fields               map[string]any   `json:"fields,omitempty"`
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

var boundGenerationOutputFields = []string{
	"content", "storageKey", "assetId", "mimeType", "bytes",
	"naturalWidth", "naturalHeight", "durationMs", "hasAudio", "videoPreview",
	"imageHistory", "status", "taskStatus", "taskProgress", "taskOutcome",
	"generationEffectKeys", "nodeRole", "resultOrigin", "smartEraseSubtitles",
	"storyboard",
}

var boundGenerationClearedErrorFields = []string{
	"error", "errorDetails", "generationErrorCode", "generationErrorSummary",
	"generationProviderCode", "generationFailure", "generationPreflightError",
	"taskOutcomeSource", "taskStage", "failedPromptFingerprint", "failedInputFingerprint",
	"fileUpload", "fileUploadProgress",
}

var settledUploadOutputFields = []string{
	"content", "storageKey", "assetId", "mimeType", "bytes",
	"naturalWidth", "naturalHeight", "durationMs", "hasAudio", "videoPreview",
	"status", "nodeRole", "resultOrigin", "fileUploadAttemptId",
}

// PatchUserCanvasDocument merges an entity-level UI delta onto the latest SQLite
// canvas document. Retries internal CAS contention atomically so disjoint edits
// never return 409 to the UI, and forces a recoverable history snapshot whenever
// an edit overlaps an entity changed on the server since baseRevision.
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
	var doc map[string]any
	if err := json.Unmarshal(currentRaw, &doc); err != nil {
		return DocumentPatchResult{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	if doc == nil {
		doc = map[string]any{}
	}

	serverAdvanced := existing.Revision > patch.BaseRevision
	mediaPreserved := false
	overlapped := false

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
			if serverAdvanced && nodeHasBoundOutput(item) {
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
			if serverAdvanced {
				overlapped = true
			}
			existingByID[id] = cloned
			orderedIDs = append(orderedIDs, id)
			continue
		}
		mergedNode, preserved := mergePatchedNode(prev, cloned)
		if preserved {
			mediaPreserved = true
		}
		if serverAdvanced && !reflect.DeepEqual(prev, mergedNode) {
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
		doc["connections"] = mergeEntitySlice(doc["connections"], patch.UpsertConnections, func(item map[string]any) bool {
			id := strings.TrimSpace(nodeString(item, "id"))
			from := strings.TrimSpace(nodeString(item, "fromNodeId"))
			to := strings.TrimSpace(nodeString(item, "toNodeId"))
			return deleteEdgeSet[id] || deleteNodeSet[from] || deleteNodeSet[to]
		})
	}

	// 3. Chat sessions: drop deleted and upsert touched sessions.
	if len(patch.DeleteChatSessionIDs) > 0 || len(patch.UpsertChatSessions) > 0 {
		deleteSessionSet := toIDSet(patch.DeleteChatSessionIDs)
		doc["chatSessions"] = mergeEntitySlice(doc["chatSessions"], patch.UpsertChatSessions, func(item map[string]any) bool {
			return deleteSessionSet[strings.TrimSpace(nodeString(item, "id"))]
		})
	}

	// 4. Top-level fields (never overwrite server-owned identity/timestamps/revision/viewport or entity lists).
	for key, value := range patch.Fields {
		switch key {
		case "id", "revision", "createdAt", "updatedAt", "remoteContentHash", "viewport", "nodes", "connections", "chatSessions":
			continue
		default:
			if serverAdvanced && !reflect.DeepEqual(doc[key], value) {
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

	mergedRaw, err := json.Marshal(doc)
	if err != nil {
		return DocumentPatchResult{}, err
	}
	mergedRaw, err = reconcileStoryboardDocument(currentRaw, mergedRaw)
	if err != nil {
		return DocumentPatchResult{}, err
	}
	mergedRaw = s.reconcileCanvasRawMediaAssetsIfNeeded(userID, existing, mergedRaw)

	reason := "automatic"
	if overlapped {
		reason = "before_merge"
	}
	summary, savedPayload, err := s.upsertUserCanvasProjectAndPayload(userID, mergedRaw, nil, reason, serverAdvanced || mediaPreserved)
	if err != nil {
		return DocumentPatchResult{}, err
	}
	return DocumentPatchResult{
		Summary:            summary,
		ServerAdvanced:     serverAdvanced,
		MediaPreserved:     mediaPreserved,
		SnapshotCaptured:   overlapped,
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

func nodeUploadInProgress(meta map[string]any) bool {
	if meta == nil {
		return false
	}
	raw, ok := meta["fileUpload"].(map[string]any)
	if !ok || raw == nil {
		return false
	}
	status := strings.ToLower(strings.TrimSpace(nodeString(raw, "status")))
	return status == "uploading" || status == "pending" || status == "processing"
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
			}
		}
		for _, key := range boundGenerationClearedErrorFields {
			delete(meta, key)
		}
		merged["metadata"] = meta
		return merged, true
	}

	// 2. Protect settled file upload against an older uploading placeholder.
	if nodeString(existingMeta, "status") == "success" && NodeHasMedia(existing) && !nodeUploadInProgress(existingMeta) && nodeUploadInProgress(incomingMeta) {
		existingAttempt := nodeString(existingMeta, "fileUploadAttemptId")
		incomingAttempt := nodeString(incomingMeta, "fileUploadAttemptId")
		sameUpload := (existingAttempt != "" && existingAttempt == incomingAttempt) || (!NodeHasMedia(incoming) && incomingAttempt == "")
		if sameUpload {
			merged := cloneNode(incoming)
			meta := nodeMetadata(merged)
			for _, key := range settledUploadOutputFields {
				if value, ok := existingMeta[key]; ok {
					meta[key] = value
				}
			}
			delete(meta, "fileUpload")
			delete(meta, "fileUploadProgress")
			delete(meta, "errorDetails")
			merged["metadata"] = meta
			return merged, true
		}
	}

	return incoming, false
}

func mergeEntitySlice(raw any, upserts []map[string]any, shouldDrop func(map[string]any) bool) []any {
	items, _ := raw.([]any)
	byID := make(map[string]map[string]any, len(items)+len(upserts))
	order := make([]string, 0, len(items)+len(upserts))
	for _, entry := range items {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(nodeString(item, "id"))
		if id == "" || shouldDrop(item) {
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
		if _, exists := byID[id]; !exists {
			order = append(order, id)
		}
		byID[id] = cloneNode(entry)
	}
	out := make([]any, 0, len(order))
	for _, id := range order {
		if item, ok := byID[id]; ok {
			out = append(out, item)
		}
	}
	return out
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
