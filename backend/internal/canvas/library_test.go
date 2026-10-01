package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasLibraryFolderAndDrawingPersistAndCAS(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	userID := "owner"
	folderRaw, _ := json.Marshal(map[string]any{"id": "folder-1", "name": "剧集"})
	folder, err := svc.UpsertUserCanvasFolder(userID, "folder-1", folderRaw)
	if err != nil || folder.Name != "剧集" || folder.ID != "folder-1" {
		t.Fatalf("folder upsert: %+v %v", folder, err)
	}
	canvasRaw := json.RawMessage(`{"id":"canvas","revision":0,"title":"分镜","folderId":"folder-1","nodes":[{"id":"n-drawing","type":"drawing","metadata":{"drawingId":"sketch"}}]}`)
	created, err := svc.UpsertUserCanvasProject(userID, canvasRaw)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 {
		t.Fatalf("canvas revision = %d", created.Revision)
	}
	got, err := svc.UserCanvasProject(userID, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["folderId"] != "folder-1" {
		t.Fatalf("folder overlay = %s", got)
	}

	drawingRaw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot": map[string]any{"elements": []any{map[string]any{"id": "shape-1"}}},
		"shapeCount": 1, "pageCount": 1,
	})
	drawing, err := svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", drawingRaw)
	if err != nil || drawing.DrawingID != "sketch" || drawing.Revision != 1 {
		t.Fatalf("drawing create: %+v %v", drawing, err)
	}
	_, err = svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", drawingRaw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
		t.Fatalf("stale drawing save = %v", err)
	}
	loaded, err := svc.UserCanvasDrawing(userID, "canvas", "sketch")
	if err != nil || loaded.Revision != 1 || string(loaded.Snapshot) == "" {
		t.Fatalf("drawing read: %+v %v", loaded, err)
	}

	if err := svc.DeleteUserCanvasFolder(userID, "folder-1"); err != nil {
		t.Fatal(err)
	}
	cleared, err := svc.UserCanvasProject(userID, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(cleared, &payload); err != nil {
		t.Fatal(err)
	}
	if folderID, _ := payload["folderId"].(string); folderID != "" {
		t.Fatalf("deleted folder still bound: %s", cleared)
	}

	if err := svc.DeleteUserCanvasProject(userID, "canvas"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UserCanvasDrawing(userID, "canvas", "sketch"); err == nil {
		t.Fatal("drawing survived canvas delete")
	}
}

func TestCanvasSaveRejectsUnknownLibraryFolder(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	_, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","folderId":"missing","nodes":[]}`))
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("unknown folder = %v", err)
	}
}

func TestCanvasDrawingRejectsForeignPreviewResource(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "res-1", UserID: "other", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{},
		"previewResourceId": "res-1",
	})
	_, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("foreign preview = %v", err)
	}
}

func TestCanvasDrawingPreservesPromptLikeSnapshot(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot": map[string]any{"elements": []any{map[string]any{"id": "text", "text": "data:image/png;base64,not-a-file"}}},
		"shapeCount": 1, "pageCount": 1,
	})
	saved, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err := json.Unmarshal(saved.Snapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	elements := snapshot["elements"].([]any)
	text := elements[0].(map[string]any)["text"]
	if text != "data:image/png;base64,not-a-file" {
		t.Fatalf("snapshot text rewritten: %#v", text)
	}
}
