package task

import (
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) Get(userID, id string) (*model.Task, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	s.hydrateProviderRequestID(task)
	return presentTask(s.deps.Present, *task), nil
}

func (s *Service) Logs(userID, id string) ([]model.TaskLog, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	logs, err := s.store.Logs(userID, id)
	if err != nil {
		return nil, err
	}
	return presentLogs(s.deps.Present, logs), nil
}

func (s *Service) list(userID string, options ListOptions) ([]Summary, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	tasks, err := s.store.List(userID, options.Limit, options.ProjectID, options.ActiveOnly)
	if err != nil {
		return nil, err
	}
	return presentSummaries(s.deps.Present, tasks), nil
}
