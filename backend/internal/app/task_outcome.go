package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) taskOutcomeFacts(tasks []model.Task) map[string]localtask.OutcomeFacts {
	return localtask.OutcomeFactsForTasks(s.repo, tasks, taskStageRequestNotSent)
}
