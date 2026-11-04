package task

import (
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestWorkflowOutputsBindOnlyMatchingPrimary(t *testing.T) {
	task := model.Task{Type: "canvas_video", InputJSON: `{"metadata":{"nodeId":"generator"}}`, ResultJSON: `{"outputs":[{"mediaType":"image"},{"mediaType":"video"},{"mediaType":"video"}]}`}
	intents := []CanvasBindingIntent{}
	for i := 0; i < 3; i++ {
		intents = append(intents, CanvasBindingIntent{OutputIndex: i, TargetBinding: &TargetBinding{NodeID: "generator"}})
	}
	targets := CanvasBindTargets(task, intents)
	if len(targets) != 1 || targets[0].NodeID != "generator" || targets[0].OutputIndex != 1 {
		t.Fatalf("targets=%+v", targets)
	}
	fallback := CanvasBindTargets(task, nil)
	if len(fallback) != 1 || fallback[0] != targets[0] {
		t.Fatalf("fallback=%+v", fallback)
	}
}

func TestWorkflowOutputsHaveTaskMediaPreview(t *testing.T) {
	url, kind, poster := MediaPreviewWithPoster(`{"outputs":[{"mediaType":"image","url":"/api/resources/image/file"}]}`, "canvas_image")
	if url != "/api/resources/image/file" || kind != "image" || poster != url {
		t.Fatalf("preview=%s kind=%s poster=%s", url, kind, poster)
	}
}
