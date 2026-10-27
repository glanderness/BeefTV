package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	localasset "infinite-canvas/backend/internal/asset"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
)

func TestReplacementFinalOutputRejectsMissingFramesAndAudio(t *testing.T) {
	p := cw.ReplacementPlan{Width: 714, Height: 1280, FPS: 30, FrameCount: 422}
	f := mediatools.MediaMetadata{Width: 714, Height: 1280, FPS: 30, VideoFrames: 422, DurationMs: 14067, HasVideo: true, HasAudio: true}
	if err := validateReplacementOutput(p, f, true); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*mediatools.MediaMetadata){
		func(v *mediatools.MediaMetadata) { v.VideoFrames = 420 },
		func(v *mediatools.MediaMetadata) { v.Width = 720 },
		func(v *mediatools.MediaMetadata) { v.FPS = 24 },
		func(v *mediatools.MediaMetadata) { v.HasAudio = false },
		func(v *mediatools.MediaMetadata) { v.HasVideo = false },
	} {
		bad := f
		mutate(&bad)
		if err := validateReplacementOutput(p, bad, true); err == nil {
			t.Fatalf("accepted broken final media: %+v", bad)
		}
	}
}

func TestReplacementNativePrepareFinishAndRecovery(t *testing.T) {
	ffmpeg, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip(err)
	}
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "dance.mp4")
	cmd := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=44100", "-t", "2.233333333", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path)
	mediatools.HideConsole(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %s %v", out, err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, _ := file.Stat()
	source, err := svc.resourceDomain().RecoverOwned("owner", "replacement-source", func() (localasset.RecoveredArtifact, error) {
		return localasset.RecoveredArtifact{Kind: "video", FileName: "dance.mp4", MimeType: "video/mp4", Size: info.Size(), Width: 640, Height: 360, DurationMs: 2233, Body: file}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	node := cw.Node{ID: "prepare", Role: "operation", OperationID: "video.replacement-prepare", OperationVersion: 1, MediaType: "text", Config: map[string]any{"maxSegments": 12}}
	task, err := svc.taskDomain().CreateCanvasMediaTask("owner", node, source.ID, "replacement-prepare-once")
	if err != nil {
		t.Fatal(err)
	}
	task, _ = svc.repo.TaskForUser("owner", task.ID)
	task.Status = model.TaskStatusRunning
	db.Model(task).Update("status", task.Status)
	if err := svc.taskWorker().processCanvasMedia(task, context.Background()); err != nil {
		t.Fatal(err)
	}
	task, _ = svc.repo.TaskForUser("owner", task.ID)
	if task.Status != model.TaskStatusSucceeded {
		t.Fatalf("prepare failed: %s", task.Error)
	}
	var result struct {
		Plan cw.ReplacementPlan `json:"replacementPlan"`
	}
	if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
		t.Fatal(err)
	}
	p := result.Plan
	if p.FrameCount != 67 || p.FPS != 30 || p.Width != 640 || p.Height != 360 || len(p.Segments) != 1 {
		t.Fatalf("bad prepared source: %+v", p)
	}
	p.Segments[0].OutputResourceID = p.Segments[0].ResourceID
	manifest, _ := json.Marshal(p)
	finish := cw.Node{ID: "finish", Role: "operation", OperationID: "video.replacement-finish", OperationVersion: 1, MediaType: "video", Config: map[string]any{"manifest": string(manifest)}}
	final, err := svc.taskDomain().CreateCanvasMediaTask("owner", finish, source.ID, "replacement-finish-once")
	if err != nil {
		t.Fatal(err)
	}
	final, _ = svc.repo.TaskForUser("owner", final.ID)
	final.Status = model.TaskStatusRunning
	db.Model(final).Update("status", final.Status)
	if err := svc.taskWorker().processCanvasMedia(final, context.Background()); err != nil {
		t.Fatal(err)
	}
	final, _ = svc.repo.TaskForUser("owner", final.ID)
	if final.Status != model.TaskStatusSucceeded {
		t.Fatalf("finish failed: %s", final.Error)
	}
	id := workflowOutputResource(final.ResultJSON)
	r, body, err := svc.OpenResource("owner", id)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	if r.Width != 640 || r.Height != 360 || r.DurationMs < 2200 || r.DurationMs > 2300 {
		t.Fatalf("wrong final media: %+v", r)
	}
	t.Setenv(mediatools.FFmpegPathEnv, "/missing/encoder")
	final.Status = model.TaskStatusRunning
	db.Model(final).Update("status", final.Status)
	if err := svc.taskWorker().processCanvasMedia(final, context.Background()); err != nil {
		t.Fatal(err)
	}
	if final.Status != model.TaskStatusSucceeded || workflowOutputResource(final.ResultJSON) != id {
		t.Fatal("recovery re-encoded instead of restoring original output")
	}
}

func TestReplacementNativeDisplayGeometryAndFractionalFPS(t *testing.T) {
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip(err)
	}
	for _, tc := range []struct {
		name, filter, rate string
		rotate             bool
		width, height, fps int
	}{
		{"anamorphic", "setsar=4/3", "30000/1001", false, 640, 360, 30},
		{"rotated", "setsar=1", "24", true, 360, 480, 24},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db := newTimelineTaskTestService(t)
			svc.dataDir = t.TempDir()
			path := filepath.Join(t.TempDir(), "source.mp4")
			if _, err := replacementCommand(context.Background(), bin, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=480x360:rate="+tc.rate, "-t", "0.5", "-vf", tc.filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", path); err != nil {
				t.Fatal(err)
			}
			if tc.rotate {
				rotated := filepath.Join(t.TempDir(), "rotated.mp4")
				if _, err := replacementCommand(context.Background(), bin, "-v", "error", "-y", "-i", path, "-c", "copy", "-metadata:s:v:0", "rotate=90", rotated); err != nil {
					t.Fatal(err)
				}
				path = rotated
			}
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			info, _ := file.Stat()
			source, err := svc.resourceDomain().RecoverOwned("owner", "geometry-source", func() (localasset.RecoveredArtifact, error) {
				return localasset.RecoveredArtifact{Kind: "video", FileName: "source.mp4", MimeType: "video/mp4", Size: info.Size(), Width: 480, Height: 360, DurationMs: 500, Body: file}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			node := cw.Node{ID: "prepare", Role: "operation", OperationID: cw.ReplacementPrepareOperation, OperationVersion: 1, MediaType: "text", Config: map[string]any{"maxSegments": 12}}
			raw, _ := json.Marshal(map[string]any{"node": node, "resourceId": source.ID})
			task := model.Task{ID: "geometry", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusRunning, InputJSON: string(raw)}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.taskWorker().processCanvasMedia(&task, context.Background()); err != nil {
				t.Fatal(err)
			}
			saved, _ := svc.repo.TaskForUser("owner", task.ID)
			if saved.Status != model.TaskStatusSucceeded {
				t.Fatal(saved.Error)
			}
			var result struct {
				Plan cw.ReplacementPlan `json:"replacementPlan"`
			}
			json.Unmarshal([]byte(saved.ResultJSON), &result)
			if result.Plan.Width != tc.width || result.Plan.Height != tc.height || result.Plan.FPS != tc.fps {
				t.Fatalf("display geometry changed: %+v", result.Plan)
			}
		})
	}
}
