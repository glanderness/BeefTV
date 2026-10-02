package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/model"
)

// Set only when building a signed Windows depth release. An empty value keeps
// the Windows feature closed instead of trusting an unsigned remote manifest.
// ldflags must remain on this package: internal/app.depthWindowsManifestPublicKeyBase64.
var depthWindowsManifestPublicKeyBase64 string

func (s *Service) depthCaptureRuntime() *depthcapture.Service {
	if s == nil {
		return depthcapture.New(depthcapture.Deps{})
	}
	s.depthCaptureOnce.Do(func() {
		s.depthCapture = depthcapture.New(depthcapture.Deps{
			DataDir:                        s.dataDir,
			Media:                          depthMedia{svc: s},
			Tasks:                          depthTasks{w: s.taskWorker()},
			WindowsManifestPublicKeyBase64: depthWindowsManifestPublicKeyBase64,
		})
	})
	return s.depthCapture
}

func (w *taskWorkerCoordinator) processDepthCapture(task *model.Task, ctx context.Context) error {
	if w == nil || w.service == nil {
		return depthcapture.ErrBadInput
	}
	return w.service.depthCaptureRuntime().Process(ctx, task)
}

type depthMedia struct {
	svc *Service
}

func (m depthMedia) Open(userID, resourceID string) (*model.Resource, io.ReadCloser, error) {
	if m.svc == nil {
		return nil, nil, depthcapture.ErrMissingVideo
	}
	return m.svc.OpenResource(userID, resourceID)
}

func (m depthMedia) SaveVideo(userID, fileName string, size int64, width, height int, durationMs int64, body io.ReadSeeker, sourceKey string) (*model.Resource, error) {
	if m.svc == nil {
		return nil, depthcapture.ErrMissingVideo
	}
	return m.svc.UploadLocalResourceFile(userID, fileName, size, "video", width, height, durationMs, body, sourceKey)
}

type depthTasks struct {
	w *taskWorkerCoordinator
}

func (t depthTasks) Progress(task *model.Task, stage string, percent int) error {
	if t.w == nil {
		return nil
	}
	return t.w.progress(task, stage, percent)
}

func (t depthTasks) Fail(task *model.Task, stage, message string) error {
	if t.w == nil {
		return nil
	}
	return t.w.failTimelineTask(task, stage, message)
}

func (t depthTasks) Complete(task *model.Task, result depthcapture.Result) error {
	if t.w == nil || t.w.service == nil || t.w.service.repo == nil {
		return nil
	}
	payload, _ := json.Marshal(result)
	task.Status = model.TaskStatusSucceeded
	task.Stage = "已完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := t.w.service.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入深度处理完成态失败: %w", err)
	}
	return nil
}
