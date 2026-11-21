package canvas

import (
	"encoding/json"
	"testing"
)

func TestCanvasLibraryPreviewFindsMediaBeyondFourNodes(t *testing.T) {
	nodes := []map[string]any{
		{"id": "text-1", "type": "text"},
		{"id": "text-2", "type": "text"},
		{"id": "text-3", "type": "text"},
		{"id": "text-4", "type": "text"},
		{"id": "image", "type": "image", "metadata": map[string]any{"content": "https://example.com/image.png"}},
	}
	preview := canvasLibraryPreviewNodes(nodes)
	if len(preview) != 1 || preview[0]["id"] != "image" {
		t.Fatalf("unexpected preview: %#v", preview)
	}
	metadata := preview[0]["metadata"].(map[string]any)
	if metadata["content"] != "https://example.com/image.png" {
		t.Fatalf("preview lost media address: %#v", metadata)
	}
}

func TestUserCanvasProjectsPageReturnsSummaryMetadataForLazyHydration(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	userID := "owner"

	folderRaw, _ := json.Marshal(map[string]any{"id": "folder-a", "name": "镜头集"})
	if _, err := svc.UpsertUserCanvasFolder(userID, "folder-a", folderRaw); err != nil {
		t.Fatalf("upsert folder: %v", err)
	}
	canvasRaw, _ := json.Marshal(map[string]any{
		"id":                 "canvas-child",
		"revision":           0,
		"workspaceProjectId": "workspace-root",
		"folderId":           "folder-a",
		"title":              "第二幕分镜",
		"nodes": []map[string]any{
			{"id": "t-1", "type": "text", "metadata": map[string]any{"content": "旁白"}},
			{"id": "i-1", "type": "image", "width": 640, "height": 360, "metadata": map[string]any{"storageKey": "image:cover-1", "content": "/api/resources/cover-1/file"}},
			{"id": "v-1", "type": "video", "metadata": map[string]any{"storageKey": "video:clip-1", "videoPreview": map[string]any{"storageKey": "image:poster-1", "content": "/api/resources/poster-1/file"}}},
		},
	})
	if _, err := svc.UpsertUserCanvasProject(userID, canvasRaw); err != nil {
		t.Fatalf("upsert canvas: %v", err)
	}

	page, err := svc.UserCanvasProjectsPage(userID, 1, 50, "", "", "updated")
	if err != nil {
		t.Fatalf("UserCanvasProjectsPage: %v", err)
	}
	if page.Total != 1 || len(page.Projects) != 1 {
		t.Fatalf("unexpected page counts: total=%d len=%d", page.Total, len(page.Projects))
	}
	summary := page.Projects[0]
	if summary.ID != "canvas-child" || summary.WorkspaceProjectID != "workspace-root" || summary.FolderID != "folder-a" {
		t.Fatalf("unexpected summary grouping: %+v", summary)
	}
	if summary.NodeCount != 3 || summary.Revision != 1 {
		t.Fatalf("unexpected nodeCount/revision: %+v", summary)
	}
	if len(summary.PreviewNodes) != 2 {
		t.Fatalf("expected 2 media preview nodes, got %d: %#v", len(summary.PreviewNodes), summary.PreviewNodes)
	}
	videoMeta, _ := summary.PreviewNodes[1]["metadata"].(map[string]any)
	videoPreview, _ := videoMeta["videoPreview"].(map[string]any)
	if videoPreview["storageKey"] != "image:poster-1" || videoPreview["content"] != "/api/resources/poster-1/file" {
		t.Fatalf("videoPreview lost storageKey/content: %#v", videoPreview)
	}
}
