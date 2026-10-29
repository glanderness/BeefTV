package canvasworkflow

import (
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestWorkflowFrameRatePreservesTimelineAndClosedArguments(t *testing.T) {
	field := OperationByID("video.frame-rate").Fields[0]
	if field.Min == nil || *field.Min != 24 || field.Max == nil || *field.Max != 60 {
		t.Fatal("editor must receive valid FPS defaults and bounds")
	}
	for _, fps := range []float64{24, 25, 30, 60} {
		n := Node{ID: "normalize", Role: "operation", OperationID: "video.frame-rate", OperationVersion: 1, MediaType: "video", Config: map[string]any{"fps": fps}}
		args, ext, mime, err := MediaCommand(n, 720, 1280)
		if err != nil || ext != ".mp4" || mime != "video/mp4" {
			t.Fatalf("frame-rate: %v %s %s %v", args, ext, mime, err)
		}
		command := strings.Join(args, " ")
		if !strings.Contains(command, "-vf fps=") || strings.Contains(command, "setpts") || strings.Contains(command, "-r ") || strings.Contains(command, "scale=") {
			t.Fatalf("must resample frames without changing speed or dimensions: %s", command)
		}
	}
	for _, fps := range []any{nil, 0.0, -1.0, 20.167, 61.0, 24.5, math.NaN(), math.Inf(1), "24; arbitrary"} {
		n := Node{ID: "normalize", Role: "operation", OperationID: "video.frame-rate", OperationVersion: 1, MediaType: "video", Config: map[string]any{"fps": fps}}
		if _, _, _, err := MediaCommand(n, 720, 1280); err == nil {
			t.Fatalf("invalid fps accepted: %v", fps)
		}
	}
}

func TestWorkflowMediaOperationsCompileClosedArguments(t *testing.T) {
	cases := []struct {
		id, kind string
		config   map[string]any
		want     []string
	}{
		{"image.crop", "image", map[string]any{"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}, []string{"-vf", "crop=640:720:320:0", "-frames:v", "1", "-an"}},
		{"image.resize", "image", map[string]any{"longEdge": 2048.0}, []string{"-vf", "scale=2048:1152:flags=bicubic", "-frames:v", "1", "-an"}},
		{"video.frame", "image", map[string]any{"seconds": 1.5}, []string{"-ss", "1.500", "-frames:v", "1", "-an"}},
		{"video.audio", "audio", nil, []string{"-vn", "-c:a", "aac"}},
	}
	for _, tc := range cases {
		n := Node{ID: "step", Role: "operation", OperationID: tc.id, OperationVersion: 1, MediaType: tc.kind, Config: tc.config}
		args, _, _, err := MediaCommand(n, 1280, 720)
		if err != nil || !reflect.DeepEqual(args, tc.want) {
			t.Fatalf("%s: %v %v", tc.id, args, err)
		}
	}
}

func TestWorkflowMediaOperationsRejectInvalidConfig(t *testing.T) {
	for _, config := range []map[string]any{{"x": 0.8, "width": 0.5, "height": 1.0}, {"width": 0.0, "height": 1.0}, {"width": 1.0, "height": 1.0, "filter": "arbitrary"}} {
		if err := ValidateOperation(Node{ID: "crop", Role: "operation", OperationID: "image.crop", OperationVersion: 1, MediaType: "image", Config: config}); err == nil {
			t.Fatal("invalid crop accepted")
		}
	}
	n := Node{ID: "crop", Role: "operation", OperationID: "video.crop", OperationVersion: 1, MediaType: "video", Config: map[string]any{"width": 1.0, "height": 1.0}}
	args, ext, mime, err := MediaCommand(n, 1279, 719)
	if err != nil || args[1] != "crop=1278:718:0:0" || ext != ".mp4" || mime != "video/mp4" {
		t.Fatalf("video crop: %v %s %s %v", args, ext, mime, err)
	}
}
