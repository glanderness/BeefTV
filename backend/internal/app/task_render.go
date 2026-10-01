package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

func (w *taskWorkerCoordinator) processTimelineRender(task *model.Task, ctx context.Context) error {
	s := w.service
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return w.failTimelineTask(task, "渲染失败", "任务缺少有效的时间线快照")
	}
	plan, err := editing.Compile(input.Timeline, nil, input.Options)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	rendered, cleanup, err := s.nativeRenderer(task.UserID).Render(ctx, plan, func(stage string, percent int) error {
		return w.progress(task, stage, percent)
	})
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if err := w.progress(task, "写入资源…", 85); err != nil {
		return err
	}
	file, err := os.Open(rendered.Path)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "读取渲染产物失败")
	}
	defer file.Close()
	fileName := fmt.Sprintf("timeline-render-%s.mp4", time.Now().Format("20060102-150405"))
	resource, _, err := s.resourceDomain().Store(task.UserID, "media", fileName, "video/mp4", rendered.Size, rendered.Width, rendered.Height, rendered.DurationMs, file, nil)
	if err != nil || resource == nil {
		return w.failTimelineTask(task, "渲染失败", "保存渲染产物失败")
	}

	result := timelineRenderResult{
		ResourceID:  resource.ID,
		FileName:    fileName,
		Size:        rendered.Size,
		DurationMs:  rendered.DurationMs,
		SubtitleSRT: rendered.SubtitleSRT,
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "渲染结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "渲染完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入渲染完成态失败: %w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线渲染完成，时长 %.1fs", float64(rendered.DurationMs)/1000), "")
	return nil
}
