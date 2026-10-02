package task

import (
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) Get(userID, id string) (*model.Task, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	s.hydrateProviderRequestID(task)
	return presentTask(s.deps.Present, *task)
}

func (s *Service) Logs(userID, id string) ([]model.TaskLog, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	logs, err := s.store.Logs(userID, id)
	if err != nil {
		return nil, err
	}
	return presentLogs(s.deps.Present, logs)
}

func (s *Service) list(userID string, options ListOptions) ([]Summary, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	tasks, err := s.store.List(userID, options.Limit, options.ProjectID, options.ActiveOnly)
	if err != nil {
		return nil, err
	}
	return presentSummaries(s.deps.Present, tasks)
}
