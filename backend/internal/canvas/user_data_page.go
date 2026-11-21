package canvas

import (
	"encoding/json"
	"fmt"
	"infinite-canvas/backend/internal/kernel"
	"sort"
	"strings"
	"time"
)

func (s *Service) UserAssetsByIDs(userID string, ids []string) ([]json.RawMessage, error) {
	return s.Library().UserAssetsByIDs(userID, ids)
}

type CanvasLibrarySummary struct {
	ID                 string           `json:"id"`
	WorkspaceProjectID string           `json:"workspaceProjectId,omitempty"`
	ProjectID          string           `json:"projectId,omitempty"`
	FolderID           string           `json:"folderId,omitempty"`
	Title              string           `json:"title"`
	CanvasTitle        string           `json:"canvasTitle,omitempty"`
	Revision           int64            `json:"revision"`
	CreatedAt          time.Time        `json:"createdAt"`
	UpdatedAt          time.Time        `json:"updatedAt"`
	NodeCount          int              `json:"nodeCount"`
	PreviewNodes       []map[string]any `json:"previewNodes"`
	LocalMediaKeys     []string         `json:"localMediaKeys,omitempty"`
}

type CanvasLibraryPage struct {
	Projects []CanvasLibrarySummary `json:"projects"`
	Page     int                    `json:"page"`
	PageSize int                    `json:"pageSize"`
	Total    int64                  `json:"total"`
	HasMore  bool                   `json:"hasMore"`
}

func (s *Service) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (CanvasLibraryPage, error) {
	if page < 1 {
		page = 1
	}
	if page > 1000000 {
		return CanvasLibraryPage{}, kernel.BadAuthRequest("页码超出范围")
	}
	if pageSize < 1 {
		pageSize = 40
	}
	if pageSize > 50 {
		pageSize = 50
	}
	projects, total, err := s.repo.UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
	if err != nil {
		return CanvasLibraryPage{}, err
	}
	result := CanvasLibraryPage{Projects: make([]CanvasLibrarySummary, 0, len(projects)), Page: page, PageSize: pageSize, Total: total, HasMore: int64(page)*int64(pageSize) < total}
	for _, project := range projects {
		parsed, err := parseCanvasSummaryPayload(project.PayloadJSON)
		if err != nil {
			return CanvasLibraryPage{}, err
		}
		preview := canvasLibraryPreviewNodes(parsed.nodes)
		result.Projects = append(result.Projects, CanvasLibrarySummary{
			ID:                 project.ID,
			WorkspaceProjectID: parsed.workspaceProjectID,
			ProjectID:          project.ProjectID,
			FolderID:           project.LibraryFolderID,
			Title:              project.Title,
			CanvasTitle:        parsed.canvasTitle,
			Revision:           project.Revision,
			CreatedAt:          project.CreatedAt,
			UpdatedAt:          project.UpdatedAt,
			NodeCount:          len(parsed.nodes),
			PreviewNodes:       preview,
			LocalMediaKeys:     parsed.localMediaKeys,
		})
	}
	return result, nil
}

func canvasLibraryPreviewNodes(nodes []map[string]any) []map[string]any {
	preview := make([]map[string]any, 0, 4)
	for _, node := range nodes {
		if node["type"] != "image" && node["type"] != "video" {
			continue
		}
		original, _ := node["metadata"].(map[string]any)
		metadata := map[string]any{}
		if key, ok := original["storageKey"].(string); ok && len(key) <= 512 {
			metadata["storageKey"] = key
		}
		for _, key := range []string{"previewContent", "content"} {
			if value, ok := original[key].(string); ok && safeCanvasPreviewURL(value) {
				metadata[key] = value
			}
		}
		if videoPreview, ok := original["videoPreview"].(map[string]any); ok {
			previewMeta := map[string]any{}
			if value, ok := videoPreview["content"].(string); ok && safeCanvasPreviewURL(value) {
				previewMeta["content"] = value
			}
			if key, ok := videoPreview["storageKey"].(string); ok && len(key) <= 512 {
				previewMeta["storageKey"] = key
			}
			if len(previewMeta) > 0 {
				metadata["videoPreview"] = previewMeta
			}
		}
		if len(metadata) == 0 {
			continue
		}
		item := map[string]any{"position": map[string]int{"x": 0, "y": 0}, "metadata": metadata}
		for _, key := range []string{"id", "type", "title"} {
			if value, ok := node[key].(string); ok {
				runes := []rune(value)
				item[key] = string(runes[:min(len(runes), 256)])
			}
		}
		for _, key := range []string{"width", "height"} {
			if value, ok := node[key].(float64); ok {
				item[key] = value
			}
		}
		preview = append(preview, item)
	}
	return preview
}

func safeCanvasPreviewURL(value string) bool {
	return len(value) <= 2048 && (strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "/api/") || strings.HasPrefix(value, "/resources/"))
}

type parsedCanvasSummaryPayload struct {
	workspaceProjectID string
	canvasTitle        string
	nodes              []map[string]any
	localMediaKeys     []string
}

// parseCanvasSummaryPayload parses workspaceProjectId, canvasTitle, nodes, and
// non-resource local storageKey references in a single streaming pass without
// constructing full AST maps for chatSessions, timeline, or directorScenes.
func parseCanvasSummaryPayload(payloadJSON string) (parsedCanvasSummaryPayload, error) {
	dec := json.NewDecoder(strings.NewReader(payloadJSON))
	tok, err := dec.Token()
	if err != nil {
		return parsedCanvasSummaryPayload{}, err
	}
	if tok == nil {
		return parsedCanvasSummaryPayload{}, nil
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return parsedCanvasSummaryPayload{}, fmt.Errorf("canvas payload must be a JSON object")
	}
	var out parsedCanvasSummaryPayload
	var seen map[string]struct{}
	scanKeys := strings.Contains(payloadJSON, `"storageKey"`)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return parsedCanvasSummaryPayload{}, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return parsedCanvasSummaryPayload{}, fmt.Errorf("expected JSON object key")
		}
		switch key {
		case "workspaceProjectId":
			value, err := readOptionalSummaryString(dec, scanKeys, &seen)
			if err != nil {
				return parsedCanvasSummaryPayload{}, err
			}
			out.workspaceProjectID = value
		case "canvasTitle":
			value, err := readOptionalSummaryString(dec, scanKeys, &seen)
			if err != nil {
				return parsedCanvasSummaryPayload{}, err
			}
			out.canvasTitle = value
		case "nodes":
			if err := dec.Decode(&out.nodes); err != nil {
				return parsedCanvasSummaryPayload{}, err
			}
			if scanKeys {
				for _, node := range out.nodes {
					collectStorageKeysFromValue(node, &seen)
				}
			}
		default:
			if err := scanValueForLocalMediaKeys(dec, scanKeys, &seen); err != nil {
				return parsedCanvasSummaryPayload{}, err
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return parsedCanvasSummaryPayload{}, err
	}
	if len(seen) > 0 {
		out.localMediaKeys = make([]string, 0, len(seen))
		for key := range seen {
			out.localMediaKeys = append(out.localMediaKeys, key)
		}
		sort.Strings(out.localMediaKeys)
	}
	return out, nil
}

func recordLocalMediaStorageKey(rawKey string, seen *map[string]struct{}) {
	key := strings.TrimSpace(rawKey)
	if len(key) > 0 && len(key) <= 512 && strings.Contains(key, ":") && !strings.HasPrefix(key, "resource:") {
		if *seen == nil {
			*seen = map[string]struct{}{}
		}
		(*seen)[key] = struct{}{}
	}
}

func collectStorageKeysFromValue(value any, seen *map[string]struct{}) {
	switch typed := value.(type) {
	case map[string]any:
		if rawKey, ok := typed["storageKey"].(string); ok {
			recordLocalMediaStorageKey(rawKey, seen)
		}
		for _, child := range typed {
			collectStorageKeysFromValue(child, seen)
		}
	case []any:
		for _, item := range typed {
			collectStorageKeysFromValue(item, seen)
		}
	}
}

func readOptionalSummaryString(dec *json.Decoder, capture bool, seen *map[string]struct{}) (string, error) {
	tok, err := dec.Token()
	if err != nil {
		return "", err
	}
	if str, ok := tok.(string); ok {
		return strings.TrimSpace(str), nil
	}
	if delim, ok := tok.(json.Delim); ok {
		if err := scanDelimitedForLocalMediaKeys(dec, delim, capture, seen); err != nil {
			return "", err
		}
	}
	return "", nil
}

func scanValueForLocalMediaKeys(dec *json.Decoder, capture bool, seen *map[string]struct{}) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	return scanDelimitedForLocalMediaKeys(dec, delim, capture, seen)
}

func scanDelimitedForLocalMediaKeys(dec *json.Decoder, delim json.Delim, capture bool, seen *map[string]struct{}) error {
	switch delim {
	case '{':
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return err
			}
			field, _ := keyTok.(string)
			if capture && field == "storageKey" {
				valTok, err := dec.Token()
				if err != nil {
					return err
				}
				if rawKey, ok := valTok.(string); ok {
					recordLocalMediaStorageKey(rawKey, seen)
				} else if nestedDelim, ok := valTok.(json.Delim); ok {
					if err := scanDelimitedForLocalMediaKeys(dec, nestedDelim, capture, seen); err != nil {
						return err
					}
				}
				continue
			}
			if err := scanValueForLocalMediaKeys(dec, capture, seen); err != nil {
				return err
			}
		}
		_, err := dec.Token()
		return err
	case '[':
		for dec.More() {
			if err := scanValueForLocalMediaKeys(dec, capture, seen); err != nil {
				return err
			}
		}
		_, err := dec.Token()
		return err
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delim)
	}
}
