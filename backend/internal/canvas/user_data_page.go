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
		var raw map[string]any
		if err := json.Unmarshal([]byte(project.PayloadJSON), &raw); err != nil {
			return CanvasLibraryPage{}, err
		}
		workspaceProjectID, _ := raw["workspaceProjectId"].(string)
		canvasTitle, _ := raw["canvasTitle"].(string)
		var nodes []map[string]any
		if rawNodes, ok := raw["nodes"]; ok && rawNodes != nil {
			nodeList, ok := rawNodes.([]any)
			if !ok {
				return CanvasLibraryPage{}, fmt.Errorf("invalid canvas nodes payload")
			}
			nodes = make([]map[string]any, 0, len(nodeList))
			for _, item := range nodeList {
				if item == nil {
					nodes = append(nodes, nil)
					continue
				}
				nodeMap, ok := item.(map[string]any)
				if !ok {
					return CanvasLibraryPage{}, fmt.Errorf("invalid canvas node payload")
				}
				nodes = append(nodes, nodeMap)
			}
		}
		preview := canvasLibraryPreviewNodes(nodes)
		var localMediaKeys []string
		if strings.Contains(project.PayloadJSON, `"storageKey"`) {
			localMediaKeys = collectLocalMediaStorageKeys(raw)
		}
		result.Projects = append(result.Projects, CanvasLibrarySummary{
			ID:                 project.ID,
			WorkspaceProjectID: strings.TrimSpace(workspaceProjectID),
			ProjectID:          project.ProjectID,
			FolderID:           project.LibraryFolderID,
			Title:              project.Title,
			CanvasTitle:        strings.TrimSpace(canvasTitle),
			Revision:           project.Revision,
			CreatedAt:          project.CreatedAt,
			UpdatedAt:          project.UpdatedAt,
			NodeCount:          len(nodes),
			PreviewNodes:       preview,
			LocalMediaKeys:     localMediaKeys,
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

func collectLocalMediaStorageKeys(raw any) []string {
	seen := map[string]struct{}{}
	walkLocalMediaStorageKeys(raw, seen)
	if len(seen) == 0 {
		return nil
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func walkLocalMediaStorageKeys(value any, seen map[string]struct{}) {
	switch typed := value.(type) {
	case map[string]any:
		if rawKey, ok := typed["storageKey"].(string); ok {
			key := strings.TrimSpace(rawKey)
			if len(key) > 0 && len(key) <= 512 && strings.Contains(key, ":") && !strings.HasPrefix(key, "resource:") {
				seen[key] = struct{}{}
			}
		}
		for _, child := range typed {
			walkLocalMediaStorageKeys(child, seen)
		}
	case []any:
		for _, item := range typed {
			walkLocalMediaStorageKeys(item, seen)
		}
	}
}
