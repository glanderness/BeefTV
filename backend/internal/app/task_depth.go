package app

import (
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type DepthCaptureCreateRequest = depthcapture.CreateRequest

func (s *Service) CreateDepthCaptureTask(userID string, req DepthCaptureCreateRequest) (*model.Task, error) {
	if s.IsDraining() {
		return nil, &AppError{Status: 503, Code: 503, Message: "服务正在维护，暂不接受新的处理任务", Retryable: true}
	}
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return nil, BadAuthRequest(depthcapture.ErrNeedVideo.Error())
	}
	resource, err := s.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, BadAuthRequest(depthcapture.ErrMissingVideo.Error())
	}
	inputJSON, err := depthcapture.PrepareInput(resourceID, resource)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	task := model.Task{
		ID: newID(), UserID: userID, ProjectID: strings.TrimSpace(req.ProjectID),
		Type: model.TaskTypeDepthCapture, Status: model.TaskStatusQueued,
		Stage: depthcapture.InitialStage, Progress: 0, Prompt: depthcapture.Prompt,
		Provider: depthcapture.Provider, Model: depthcapture.ModelID, InputJSON: string(inputJSON),
	}
	if err := s.createTaskWithinStorageQuota(&task, policy); err != nil {
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
		}
		return nil, err
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "深度动作捕捉任务已进入队列", "")
	return taskForOutput(task), nil
}
