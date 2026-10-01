package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/model"
)

func TestCreateDepthCaptureTaskQueuesFixedStandardProfile(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedResource(t, db, "res-depth-video", "usr-depth", "video/mp4")
	if err := db.Create(&model.CanvasProject{ID: "prj-depth", UserID: "usr-depth", Title: "depth"}).Error; err != nil {
		t.Fatalf("seed canvas: %v", err)
	}

	task, err := svc.CreateDepthCaptureTask("usr-depth", DepthCaptureCreateRequest{ProjectID: "prj-depth", ResourceID: "res-depth-video"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if task.Type != model.TaskTypeDepthCapture || task.Status != model.TaskStatusQueued {
		t.Fatalf("task = %s/%s, want depth_capture/queued", task.Type, task.Status)
	}
	if task.Provider != "local" || task.Model != "video-depth-anything-small" {
		t.Fatalf("provider/model = %s/%s", task.Provider, task.Model)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load stored task: %v", err)
	}
	var input depthcapture.Input
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatalf("decode input: %v", err)
	}
	if input.ResourceID != "res-depth-video" || input.Profile != depthcapture.StandardProfile {
		t.Fatalf("input = %#v", input)
	}
}

func TestCreateDepthCaptureTaskRejectsNonVideoResource(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedResource(t, db, "res-depth-image", "usr-depth", "image/png")

	_, err := svc.CreateDepthCaptureTask("usr-depth", DepthCaptureCreateRequest{ResourceID: "res-depth-image"})
	if err == nil || !strings.Contains(err.Error(), "视频") {
		t.Fatalf("err = %v, want video validation", err)
	}
}
