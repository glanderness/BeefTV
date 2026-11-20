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

func TestReplacementNativePrepareFinishAndRecovery(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
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
	id := cw.OutputResource(final.ResultJSON)
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
	if final.Status != model.TaskStatusSucceeded || cw.OutputResource(final.ResultJSON) != id {
		t.Fatal("recovery re-encoded instead of restoring original output")
	}
}

func TestReplacementNativeDisplayGeometryAndFractionalFPS(t *testing.T) {
	bin, err := exec.LookPath("ffmpeg")
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
			if _, err := exec.Command(bin, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=480x360:rate="+tc.rate, "-t", "0.5", "-vf", tc.filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
				t.Fatal(err)
			}
			if tc.rotate {
				rotated := filepath.Join(t.TempDir(), "rotated.mp4")
				if out, err := exec.Command(bin, "-v", "error", "-y", "-display_rotation:v:0", "90", "-i", path, "-c", "copy", rotated).CombinedOutput(); err != nil {
					if _, legacyErr := exec.Command(bin, "-v", "error", "-y", "-i", path, "-c", "copy", "-metadata:s:v:0", "rotate=90", rotated).CombinedOutput(); legacyErr != nil {
						t.Fatalf("rotate fixture: %s (%v / %v)", out, err, legacyErr)
					}
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

func TestReplacementPrepareHonorsMinRefSecondsAxisBoundsAndCorruptLimits(t *testing.T) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip(err)
	}
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	path := filepath.Join(t.TempDir(), "short1080p.mp4")
	if out, err := exec.Command(bin, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "1.0", "-c:v", "libx264", "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %s %v", out, err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, _ := file.Stat()
	source, err := svc.resourceDomain().RecoverOwned("owner", "hd-short-source", func() (localasset.RecoveredArtifact, error) {
		return localasset.RecoveredArtifact{Kind: "video", FileName: "short1080p.mp4", MimeType: "video/mp4", Size: info.Size(), Width: 1920, Height: 1080, DurationMs: 1000, Body: file}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// 1) Corrupt limits JSON must fail closed instead of falling back to defaults.
	badNode := cw.Node{ID: "prepare", Role: "operation", OperationID: cw.ReplacementPrepareOperation, OperationVersion: 1, MediaType: "text", Config: map[string]any{"maxSegments": 12, "limits": "{corrupt"}}
	badRaw, _ := json.Marshal(map[string]any{"node": badNode, "resourceId": source.ID})
	badTask := model.Task{ID: "bad-limits", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusRunning, InputJSON: string(badRaw)}
	if err := db.Create(&badTask).Error; err != nil {
		t.Fatal(err)
	}
	_ = svc.taskWorker().processCanvasMedia(&badTask, context.Background())
	if savedBad, _ := svc.repo.TaskForUser("owner", badTask.ID); savedBad == nil || savedBad.Status != model.TaskStatusFailed {
		t.Fatalf("accepted corrupt limits JSON: %+v", savedBad)
	}

	// 2) Tight MaxVideoBytes must fail closed when encoded reference segment exceeds limit.
	tinyLim := cw.DefaultReplacementLimits()
	tinyLim.MaxVideoBytes = 64
	tinyLimJSON, _ := json.Marshal(tinyLim)
	tinyNode := cw.Node{ID: "prepare", Role: "operation", OperationID: cw.ReplacementPrepareOperation, OperationVersion: 1, MediaType: "text", Config: map[string]any{"maxSegments": 12, "limits": string(tinyLimJSON)}}
	tinyRaw, _ := json.Marshal(map[string]any{"node": tinyNode, "resourceId": source.ID})
	tinyTask := model.Task{ID: "tiny-bytes", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusRunning, InputJSON: string(tinyRaw)}
	if err := db.Create(&tinyTask).Error; err != nil {
		t.Fatal(err)
	}
	_ = svc.taskWorker().processCanvasMedia(&tinyTask, context.Background())
	if savedTiny, _ := svc.repo.TaskForUser("owner", tinyTask.ID); savedTiny == nil || savedTiny.Status != model.TaskStatusFailed {
		t.Fatalf("accepted segment exceeding MaxVideoBytes=64: %+v", savedTiny)
	}

	// 3) MinRefSeconds=4 on a 1s 1920x1080 clip with 1280x720..1920x1080 bounds must pad to 120 frames and preserve >=1280x720.
	lim := cw.DefaultReplacementLimits()
	lim.MinRefSeconds, lim.MinSeconds, lim.MaxSeconds = 4, 4, 10
	lim.MinVideoWidth, lim.MinVideoHeight = 1280, 720
	lim.MaxVideoWidth, lim.MaxVideoHeight = 1920, 1080
	limJSON, _ := json.Marshal(lim)
	okNode := cw.Node{ID: "prepare", Role: "operation", OperationID: cw.ReplacementPrepareOperation, OperationVersion: 1, MediaType: "text", Config: map[string]any{"maxSegments": 12, "minSeconds": 4, "maxSeconds": 10, "limits": string(limJSON)}}
	okRaw, _ := json.Marshal(map[string]any{"node": okNode, "resourceId": source.ID})
	okTask := model.Task{ID: "hd-minref4", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusRunning, InputJSON: string(okRaw)}
	if err := db.Create(&okTask).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.taskWorker().processCanvasMedia(&okTask, context.Background()); err != nil {
		t.Fatalf("prepare MinRefSeconds=4 failed: %v", err)
	}
	saved, _ := svc.repo.TaskForUser("owner", okTask.ID)
	if saved == nil || saved.Status != model.TaskStatusSucceeded {
		t.Fatalf("prepare MinRefSeconds=4 failed: %+v", saved)
	}
	var result struct {
		Plan cw.ReplacementPlan `json:"replacementPlan"`
	}
	if err := json.Unmarshal([]byte(saved.ResultJSON), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Plan.Segments) != 1 || result.Plan.Segments[0].ReferenceFrames != 120 {
		t.Fatalf("expected 120 padded reference frames, got %+v", result.Plan)
	}
	segRes, segBody, err := svc.OpenResource("owner", result.Plan.Segments[0].ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	segBody.Close()
	if segRes.Width < 1280 || segRes.Width > 1920 || segRes.Height < 720 || segRes.Height > 1080 {
		t.Fatalf("prepared segment dimensions violated 1280x720..1920x1080: %dx%d", segRes.Width, segRes.Height)
	}
}
