package canvas

import (
	"encoding/json"
	"os"
	"path/filepath"
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
		"canvasTitle":        "镜头二·夜景",
		"nodes": []map[string]any{
			{"id": "t-1", "type": "text", "metadata": map[string]any{"content": "旁白"}},
			{"id": "i-1", "type": "image", "width": 640, "height": 360, "metadata": map[string]any{"storageKey": "resource:cover-1", "content": "/api/resources/cover-1/file"}},
			{"id": "v-1", "type": "video", "metadata": map[string]any{"storageKey": "video:u1:clip-1", "videoPreview": map[string]any{"storageKey": "image:u1:poster-1", "content": "/api/resources/poster-1/file"}}},
		},
		"timeline": map[string]any{
			"clips": []map[string]any{
				{"id": "clip-1", "directMedia": map[string]any{"storageKey": "audio:u1:bgm-1"}},
			},
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
	if summary.ID != "canvas-child" || summary.WorkspaceProjectID != "workspace-root" || summary.FolderID != "folder-a" || summary.CanvasTitle != "镜头二·夜景" {
		t.Fatalf("unexpected summary grouping/title: %+v", summary)
	}
	if summary.NodeCount != 3 || summary.Revision != 1 {
		t.Fatalf("unexpected nodeCount/revision: %+v", summary)
	}
	if len(summary.PreviewNodes) != 2 {
		t.Fatalf("expected 2 media preview nodes, got %d: %#v", len(summary.PreviewNodes), summary.PreviewNodes)
	}
	videoMeta, _ := summary.PreviewNodes[1]["metadata"].(map[string]any)
	videoPreview, _ := videoMeta["videoPreview"].(map[string]any)
	if videoPreview["storageKey"] != "image:u1:poster-1" || videoPreview["content"] != "/api/resources/poster-1/file" {
		t.Fatalf("videoPreview lost storageKey/content: %#v", videoPreview)
	}
	wantLocalKeys := []string{"audio:u1:bgm-1", "image:u1:poster-1", "video:u1:clip-1"}
	if len(summary.LocalMediaKeys) != len(wantLocalKeys) {
		t.Fatalf("LocalMediaKeys = %#v, want %#v", summary.LocalMediaKeys, wantLocalKeys)
	}
	for i, want := range wantLocalKeys {
		if summary.LocalMediaKeys[i] != want {
			t.Fatalf("LocalMediaKeys[%d] = %q, want %q", i, summary.LocalMediaKeys[i], want)
		}
	}
}

func TestScanLocalMediaStorageKeysStreamingEdgeCases(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"workspaceProjectId": "ws-stream",
		"canvasTitle":        "单遍流式测试",
		"nodes": []map[string]any{
			{"id": "n1", "type": "image", "metadata": map[string]any{"storageKey": "image:u1:node-1"}},
		},
		"chatSessions": []map[string]any{
			{
				"id":   "s1",
				"tags": []string{"storageKey", "image:u1:not-an-object-value"},
				"attachments": []map[string]any{
					{"storageKey": "image:u1:chat-1"},
					{"storageKey": "resource:server-managed"},
					{"storageKey": "plain-without-colon"},
					{"storageKey": map[string]any{"storageKey": "audio:u1:nested-1"}},
				},
			},
		},
		"largeText": string(make([]byte, 64*1024)),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	parsed, err := parseCanvasSummaryPayload(string(payload))
	if err != nil {
		t.Fatalf("parseCanvasSummaryPayload: %v", err)
	}
	if parsed.workspaceProjectID != "ws-stream" || parsed.canvasTitle != "单遍流式测试" || len(parsed.nodes) != 1 {
		t.Fatalf("unexpected parsed metadata: %+v", parsed)
	}
	want := []string{"audio:u1:nested-1", "image:u1:chat-1", "image:u1:node-1"}
	if len(parsed.localMediaKeys) != len(want) {
		t.Fatalf("localMediaKeys = %#v, want %#v", parsed.localMediaKeys, want)
	}
	for i := range want {
		if parsed.localMediaKeys[i] != want[i] {
			t.Fatalf("localMediaKeys[%d] = %q, want %q", i, parsed.localMediaKeys[i], want[i])
		}
	}
	emptyParsed, err := parseCanvasSummaryPayload(`{"nodes":[{"id":"n1","type":"text"}]}`)
	if err != nil || emptyParsed.localMediaKeys != nil || len(emptyParsed.nodes) != 1 {
		t.Fatalf("expected nil localMediaKeys and 1 node, got %+v err=%v", emptyParsed, err)
	}

	// Non-string workspaceProjectId/canvasTitle and mixed media prefixes must never fail summary listing.
	nonStringParsed, err := parseCanvasSummaryPayload(`{
		"workspaceProjectId": 12345,
		"canvasTitle": {"nested": true},
		"nodes": [
			{"id":"n1","type":"image","metadata":{"storageKey":"generation-image:u1:gen-1"}},
			{"id":"n2","type":"video","metadata":{"storageKey":"external-video:u1:ext-1"}}
		]
	}`)
	if err != nil {
		t.Fatalf("non-string metadata should not fail summary parse: %v", err)
	}
	if nonStringParsed.workspaceProjectID != "" || nonStringParsed.canvasTitle != "" || len(nonStringParsed.nodes) != 2 {
		t.Fatalf("unexpected nonStringParsed: %+v", nonStringParsed)
	}
	wantMixed := []string{"external-video:u1:ext-1", "generation-image:u1:gen-1"}
	if len(nonStringParsed.localMediaKeys) != len(wantMixed) || nonStringParsed.localMediaKeys[0] != wantMixed[0] || nonStringParsed.localMediaKeys[1] != wantMixed[1] {
		t.Fatalf("nonStringParsed.localMediaKeys = %#v, want %#v", nonStringParsed.localMediaKeys, wantMixed)
	}
}

func TestLocalMediaKeysSharedCrossLanguageContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "local_media_keys_contract.json"))
	if err != nil {
		t.Fatalf("read shared contract fixture: %v", err)
	}
	var cases []struct {
		Name                   string          `json:"name"`
		Payload                json.RawMessage `json:"payload"`
		ExpectedLocalMediaKeys []string        `json:"expectedLocalMediaKeys"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse shared contract fixture: %v", err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			parsed, err := parseCanvasSummaryPayload(string(tc.Payload))
			if err != nil {
				t.Fatalf("parseCanvasSummaryPayload: %v", err)
			}
			if len(parsed.localMediaKeys) != len(tc.ExpectedLocalMediaKeys) {
				t.Fatalf("localMediaKeys = %#v, want %#v", parsed.localMediaKeys, tc.ExpectedLocalMediaKeys)
			}
			for i, want := range tc.ExpectedLocalMediaKeys {
				if parsed.localMediaKeys[i] != want {
					t.Fatalf("localMediaKeys[%d] = %q, want %q", i, parsed.localMediaKeys[i], want)
				}
			}
		})
	}
}
