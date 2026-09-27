package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const depthStandardProfile = "vda-small-mps-standard-v1"

type DepthCaptureCreateRequest struct {
	ProjectID  string `json:"projectId"`
	ResourceID string `json:"resourceId"`
}

type depthCaptureInput struct {
	ResourceID string `json:"resourceId"`
	Profile    string `json:"profile"`
}

func (s *Service) CreateDepthCaptureTask(userID string, req DepthCaptureCreateRequest) (*model.Task, error) {
	if s.IsDraining() {
		return nil, &AppError{Status: 503, Code: 503, Message: "服务正在维护，暂不接受新的处理任务", Retryable: true}
	}
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return nil, BadAuthRequest("必须指定待处理视频")
	}
	resource, err := s.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, BadAuthRequest("无法读取待处理视频，可能已被删除")
	}
	if !strings.HasPrefix(resource.MimeType, "video/") {
		return nil, BadAuthRequest("深度动作捕捉仅支持视频资源")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	inputJSON, _ := json.Marshal(depthCaptureInput{ResourceID: resourceID, Profile: depthStandardProfile})
	task := model.Task{
		ID: newID(), UserID: userID, ProjectID: strings.TrimSpace(req.ProjectID),
		Type: model.TaskTypeDepthCapture, Status: model.TaskStatusQueued,
		Stage: "检查深度处理组件", Progress: 0, Prompt: "深度动作捕捉",
		Provider: "local", Model: "video-depth-anything-small", InputJSON: string(inputJSON),
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
