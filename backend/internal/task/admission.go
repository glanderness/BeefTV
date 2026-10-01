package task

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) admit(userID string, req CreateRequest) (*model.Task, error) {
	operationKey, err := ClientOperationID(req.Input)
	if err != nil {
		return nil, err
	}
	var operationHash string
	if operationKey != "" {
		operationHash, err = ClientOperationHash(req)
		if err != nil {
			return nil, err
		}
	}
	if operationKey != "" {
		if s.store == nil {
			return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
		}
		existing, lookupErr := s.store.TaskByClientOperation(userID, operationKey)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if existing != nil {
			return admitExisting(*existing, req, s.deps.Present)
		}
	}
	if strings.TrimSpace(req.AdmissionID) == "" && IsRetiredAgentTaskInput(req.Operation, req.Input) {
		return nil, kernel.BadAuthRequest(RetiredAgentBoundaryMessage)
	}
	if s.deps.Runtime != nil && s.deps.Runtime.IsDraining() {
		return nil, drainError(DrainCreateMessage)
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return nil, kernel.BadAuthRequest(PromptRequiredMessage)
	}
	taskType := strings.TrimSpace(req.Type)
	if err := ValidateType(taskType); err != nil {
		return nil, kernel.BadAuthRequest(err.Error())
	}
	normalizedInput, err := NormalizeInput(req.Input)
	if err != nil {
		return nil, err
	}
	if err := s.validateRetryType(userID, taskType, normalizedInput); err != nil {
		return nil, err
	}
	if s.deps.Secrets != nil {
		normalizedInput, err = s.deps.Secrets.ResolveManaged(normalizedInput)
		if err != nil {
			return nil, err
		}
	}
	var binding *RouteBinding
	if s.deps.Catalog != nil {
		selected, selectErr := s.deps.Catalog.Select(userID, SelectRequest{
			Input:          normalizedInput,
			LogicalModelID: strings.TrimSpace(req.LogicalModelID),
			Type:           taskType,
			Operation:      req.Operation,
		})
		if selectErr != nil {
			return nil, selectErr
		}
		if selected.Input != nil {
			normalizedInput = selected.Input
		}
		binding = selected.Binding
	}
	if strings.HasPrefix(taskType, "video_") {
		hasConfig := s.deps.Catalog != nil && s.deps.Catalog.HasExecutableVideoConfig(normalizedInput)
		if !hasConfig {
			if mode, _ := normalizedInput["mode"].(string); mode != "video" {
				return nil, kernel.BadAuthRequest(VideoModeRequiredMessage)
			}
			return nil, kernel.BadAuthRequest(VideoConfigRequiredMessage)
		}
	}
	if s.deps.TextReplay != nil && s.deps.TextReplay.IsRequest(normalizedInput) {
		return s.admitTextReplay(userID, req, normalizedInput)
	}
	if s.deps.Catalog != nil {
		if err := s.deps.Catalog.RequireCustomChannels(normalizedInput); err != nil {
			return nil, err
		}
		if err := s.deps.Catalog.ValidateCapability(normalizedInput); err != nil {
			return nil, err
		}
	}
	if s.deps.Media != nil && s.deps.Media.ContainsInlineData(normalizedInput) {
		return nil, kernel.BadAuthRequest(InlineMediaRejectedMessage)
	}
	if s.deps.Policy == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务服务不可用")
	}
	limit, err := s.deps.Policy.ActiveTaskLimit()
	if err != nil {
		return nil, err
	}
	if s.store == nil {
		return nil, localStorageFailed(errStoreRequired)
	}
	activeTasks, err := s.store.ActiveTaskCount(userID)
	if err != nil {
		return nil, localStorageFailed(err)
	}
	if activeTasks >= int64(limit) {
		return nil, activeLimitError(limit)
	}
	task := model.Task{
		ID:        s.newID(),
		UserID:    userID,
		TraceID:   req.TraceID,
		RequestID: req.RequestID,
		ProjectID: req.ProjectID,
		Type:      taskType,
		Status:    model.TaskStatusQueued,
		Stage:     "等待队列调度",
		Progress:  5,
		Prompt:    prompt,
		Operation: req.Operation,
		Provider:  req.Provider,
		Model:     req.Model,
	}
	if operationKey != "" {
		task.ClientOperationID = &operationKey
		task.ClientOperationHash = operationHash
	}
	if id := strings.TrimSpace(req.AdmissionID); id != "" {
		task.ID = id
	}
	if binding != nil {
		task.LogicalModelID = binding.LogicalModelID
		task.LogicalModelRevisionID = binding.LogicalModelRevisionID
		task.RouteID = binding.RouteID
		task.ChannelModelID = binding.ChannelModelID
		task.RouteRun = 1
		task.Model = binding.Model
		task.Provider = "managed"
	}
	if s.deps.Projects != nil {
		if err := s.deps.Projects.EnsureActive(userID, req.ProjectID); err != nil {
			return nil, err
		}
	}
	if req.PrepareOnly {
		encoded, encodeErr := json.Marshal(normalizedInput)
		if encodeErr != nil {
			return nil, encodeErr
		}
		task.InputJSON = string(encoded)
		return &task, nil
	}
	if s.deps.Secrets != nil {
		if err := s.deps.Secrets.Protect(normalizedInput); err != nil {
			return nil, err
		}
	}
	inputJSON, err := json.Marshal(normalizedInput)
	if err != nil {
		return nil, fmt.Errorf("序列化任务输入失败：%w", err)
	}
	task.InputJSON = string(inputJSON)
	if s.deps.Persist == nil {
		return nil, localStorageFailed(errors.New("task persistence is required"))
	}
	err = s.deps.Persist.CreateAdmitted(&task, limit)
	if mapped, mapErr := mapPersistError(err, req, s.deps.Present, limit); mapErr != nil || mapped != nil {
		return mapped, mapErr
	}
	if s.deps.Activity != nil {
		s.deps.Activity.Record(userID, "task", 1)
	}
	s.log(userID, task.ID, "info", "任务已进入队列", "")
	return presentTask(s.deps.Present, task), nil
}

func (s *Service) admitTextReplay(userID string, req CreateRequest, normalizedInput map[string]any) (*model.Task, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		prompt = strings.TrimSpace(fmt.Sprint(normalizedInput["prompt"]))
	}
	if prompt == "" {
		return nil, kernel.BadAuthRequest(PromptRequiredMessage)
	}
	taskType := strings.TrimSpace(req.Type)
	if err := ValidateType(taskType); err != nil {
		return nil, err
	}
	task := model.Task{
		ID: s.newID(), UserID: userID, TraceID: req.TraceID, RequestID: req.RequestID, ProjectID: req.ProjectID,
		Type: taskType, Status: model.TaskStatusTextReplay, Stage: "文本持久化（前端自管）", Progress: 5,
		Prompt: prompt, Operation: req.Operation, Provider: req.Provider, Model: strings.TrimSpace(req.Model),
	}
	if s.deps.Secrets != nil {
		if err := s.deps.Secrets.Protect(normalizedInput); err != nil {
			return nil, err
		}
	}
	inputJSON, _ := json.Marshal(normalizedInput)
	task.InputJSON = string(inputJSON)
	if s.deps.Policy == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务服务不可用")
	}
	limit, err := s.deps.Policy.ActiveTaskLimit()
	if err != nil {
		return nil, err
	}
	if s.deps.Persist == nil {
		return nil, localStorageFailed(errors.New("task persistence is required"))
	}
	if err := s.deps.Persist.CreateAdmitted(&task, limit); err != nil {
		if mapped, mapErr := mapPersistError(err, req, s.deps.Present, limit); mapErr != nil || mapped != nil {
			return mapped, mapErr
		}
	}
	s.log(userID, task.ID, "info", "文本持久化任务已创建（前端自管）", "")
	return presentTask(s.deps.Present, task), nil
}
