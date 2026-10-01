package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// CreateLocalTask is the desktop kernel admission entry. Trusted AdmissionID
// and PrepareOnly stay on the domain command; public JSON cannot set them.
func (s *Service) CreateLocalTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateTask(userID, request)
}
