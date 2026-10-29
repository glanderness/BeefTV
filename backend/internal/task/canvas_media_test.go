package task

import (
	"encoding/json"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestReplacementFinishAdmissionRejectsForeignSegments(t *testing.T) {
	svc, _, media, _ := newSpecializedMem(nil)
	for _, id := range []string{"source", "reference"} {
		r := readyVideo(id)
		r.Kind = "video"
		r.MimeType = "video/mp4"
		media.put("owner", r)
	}
	foreign := readyVideo("generated")
	foreign.Kind = "video"
	foreign.MimeType = "video/mp4"
	media.put("other", foreign)
	p, _ := cw.PlanCharacterReplacement(640, 360, 30, 30, nil, 12)
	p.SourceResourceID = "source"
	p.Segments[0].ResourceID = "reference"
	p.Segments[0].OutputResourceID = "generated"
	raw, _ := json.Marshal(p)
	n := cw.Node{ID: "finish", Role: "operation", OperationID: cw.ReplacementFinishOperation, OperationVersion: 1, MediaType: "video", Config: map[string]any{"manifest": string(raw)}}
	if _, err := svc.CreateCanvasMediaTask("owner", n, "source", "foreign-finish"); err == nil {
		t.Fatal("foreign generation accepted")
	}
	media.put("owner", foreign)
	if _, err := svc.CreateCanvasMediaTask("owner", n, "source", "owned-finish"); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasMediaAdmissionIsLocalOwnedAndIdempotent(t *testing.T) {
	svc, _, media, _ := newSpecializedMem(nil)
	source := readyVideo("source")
	source.Kind = "video"
	source.MimeType = "video/mp4"
	source.Width = 1280
	source.Height = 720
	media.put("owner", source)
	node := cw.Node{ID: "frame", Role: "operation", OperationID: "video.frame", OperationVersion: 1, MediaType: "image", Config: map[string]any{"seconds": 0.0}}
	first, err := svc.CreateCanvasMediaTask("owner", node, "source", "frame-once")
	if err != nil {
		t.Fatal(err)
	}
	if first.Provider != "local" || first.Type != model.TaskTypeCanvasMediaTransform || first.Model != "ffmpeg" {
		t.Fatalf("unexpected task: %+v", first)
	}
	second, err := svc.CreateCanvasMediaTask("owner", node, "source", "frame-once")
	if err != nil || second.ID != first.ID {
		t.Fatalf("idempotency: %v", err)
	}
	if _, err = svc.CreateCanvasMediaTask("foreign", node, "source", "foreign"); err == nil {
		t.Fatal("foreign resource accepted")
	}
	node.Config["seconds"] = 43200.0
	if _, err = svc.CreateCanvasMediaTask("owner", node, "source", "invalid"); err == nil {
		t.Fatal("out of range frame accepted")
	}
}

func TestCanvasMediaAdmissionNormalizesHistoricalMediaKind(t *testing.T) {
	svc, _, media, _ := newSpecializedMem(nil)
	source := readyVideo("historical")
	source.Kind, source.MimeType = "media", "video/mp4"
	source.Width, source.Height = 1280, 720
	media.put("owner", source)
	node := cw.Node{ID: "frame", Role: "operation", OperationID: "video.frame", OperationVersion: 1, MediaType: "image", Config: map[string]any{"seconds": 0.0}}
	if _, err := svc.CreateCanvasMediaTask("owner", node, source.ID, "historical-frame"); err != nil {
		t.Fatal(err)
	}
	source.MimeType = "audio/wav"
	media.put("owner", source)
	if _, err := svc.CreateCanvasMediaTask("owner", node, source.ID, "wrong-kind"); err == nil {
		t.Fatal("audio accepted as a video")
	}
}
