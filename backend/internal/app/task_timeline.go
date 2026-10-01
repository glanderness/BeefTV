package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/transcription"
)

type timelineTranscriptionInput struct {
	ResourceID string `json:"resourceId"`
	Language   string `json:"language"`
}

func (w *taskWorkerCoordinator) processTimelineTranscription(task *model.Task, ctx context.Context) error {
	s := w.service
	baseURL := strings.TrimSpace(os.Getenv(transcription.BaseURLEnv))
	if baseURL == "" {
		return w.failTimelineTask(task, "转写失败", "未配置本地转写服务：请设置 CANVAS_WHISPER_BASE_URL 指向 whisper.cpp 服务")
	}
	var input timelineTranscriptionInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || strings.TrimSpace(input.ResourceID) == "" {
		return w.failTimelineTask(task, "转写失败", "任务缺少有效的资源引用")
	}
	if err := s.RequireFeature(FeatureTimelineTranscription); err != nil {
		return w.failTimelineTask(task, "转写失败", "字幕转写暂未开放")
	}
	s.logInfo(task.UserID, task.ID, "时间线转写任务开始", "")

	result, err := s.transcriptionExecutor(task.UserID, baseURL).Run(ctx, input.ResourceID, input.Language, func(stage string, percent int) error {
		return w.progress(task, stage, percent)
	})
	if err != nil {
		return w.failTimelineTask(task, "转写失败", err.Error())
	}

	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "转写失败", "转写结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "转写完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入转写完成态失败: %w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线转写完成，段落 %d", len(result.Segments)), "")
	return nil
}

func (w *taskWorkerCoordinator) failTimelineTask(task *model.Task, stage string, message string) error {
	s := w.service
	done, err := s.repo.UpdateTaskTerminalState(task.ID, task.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, stage, message, time.Now())
	if err != nil {
		return fmt.Errorf("写入转写失败态失败: %w", err)
	}
	if !done {
		return fmt.Errorf("时间线任务状态或租约已变化：%w", repository.ErrTaskStateConflict)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线转写失败: %s", message), "")
	return nil
}

func (w *taskWorkerCoordinator) progress(task *model.Task, stage string, progress int) error {
	if err := w.service.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, stage, progress); err != nil {
		return fmt.Errorf("更新转写进度失败: %w", err)
	}
	return nil
}

func (s *Service) logInfo(userID string, taskID string, message string, extra string) {
	s.log(userID, taskID, "info", message, extra)
}

type TimelineTranscriptionCreateRequest struct {
	ResourceID string `json:"resourceId"`
	Language   string `json:"language"`
	ProjectID  string `json:"projectId"`
}

func (s *Service) CreateTimelineTranscriptionTask(userID string, req TimelineTranscriptionCreateRequest) (*model.Task, error) {
	if s.IsDraining() {
		return nil, &AppError{Status: 503, Code: 503, Message: "服务正在维护，暂不接受新的生成任务", Retryable: true}
	}
	if err := s.RequireFeature(FeatureTimelineTranscription); err != nil {
		return nil, err
	}
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return nil, BadAuthRequest("必须指定待转写媒体")
	}
	resource, err := s.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, BadAuthRequest("无法读取待转写媒体，可能已被删除")
	}
	if !transcription.IsTranscribableMIME(resource.MimeType) {
		return nil, BadAuthRequest("仅支持音视频文件转写")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	input := timelineTranscriptionInput{ResourceID: resourceID, Language: strings.TrimSpace(req.Language)}
	inputJSON, _ := json.Marshal(input)
	task := model.Task{
		ID: newID(), UserID: userID, ProjectID: req.ProjectID,
		Type: model.TaskTypeTimelineTranscription, Status: model.TaskStatusQueued,
		Stage: "等待队列调度", Progress: 5, Prompt: "字幕转写",
		Provider: "local", Model: "whisper.cpp", InputJSON: string(inputJSON),
	}
	if err := s.createTaskWithinStorageQuota(&task, policy); err != nil {
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
		}
		return nil, err
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "字幕转写任务已进入队列", "")
	return taskForOutput(task), nil
}

type TimelineRenderCreateRequest struct {
	ProjectID string          `json:"projectId"`
	Timeline  editing.Project `json:"timeline"`
	Options   editing.Options `json:"options"`
}

type timelineRenderInput struct {
	ProjectID string          `json:"projectId"`
	Timeline  editing.Project `json:"timeline"`
	Options   editing.Options `json:"options"`
}

type TimelineRenderPlanRequest struct {
	Timeline editing.Project      `json:"timeline"`
	Sources  []editing.SourceMeta `json:"sources"`
	Options  editing.Options      `json:"options"`
}

type timelineRenderResult struct {
	ResourceID  string `json:"resourceId"`
	FileName    string `json:"fileName"`
	Size        int64  `json:"size"`
	DurationMs  int64  `json:"durationMs"`
	SubtitleSRT string `json:"subtitleSrt,omitempty"`
}

func (s *Service) CreateTimelineRenderTask(userID string, req TimelineRenderCreateRequest) (*model.Task, error) {
	if s.IsDraining() {
		return nil, &AppError{Status: 503, Code: 503, Message: "服务正在维护，暂不接受新的生成任务", Retryable: true}
	}
	plan, err := editing.Compile(req.Timeline, nil, req.Options)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	if !plan.HasMedia() {
		return nil, BadAuthRequest("时间线没有可渲染的媒体片段")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	input := timelineRenderInput{ProjectID: strings.TrimSpace(req.ProjectID), Timeline: req.Timeline, Options: req.Options}
	inputJSON, _ := json.Marshal(input)
	task := model.Task{
		ID: newID(), UserID: userID, ProjectID: strings.TrimSpace(req.ProjectID),
		Type: model.TaskTypeTimelineRender, Status: model.TaskStatusQueued,
		Stage: "等待队列调度", Progress: 5, Prompt: "时间线渲染",
		Provider: "local", Model: "ffmpeg", InputJSON: string(inputJSON),
	}
	if err := s.createTaskWithinStorageQuota(&task, policy); err != nil {
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
		}
		return nil, err
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "时间线渲染任务已进入队列", "")
	return taskForOutput(task), nil
}

func (s *Service) CompileTimelineRenderPlan(userID string, req TimelineRenderPlanRequest) (*editing.Plan, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, Unauthorized("未登录")
	}
	plan, err := editing.Compile(req.Timeline, req.Sources, req.Options)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	return plan, nil
}
