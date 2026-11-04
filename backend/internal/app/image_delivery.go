package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) completionInputJSON(task model.Task, resultJSON []byte) (string, error) {
	return localtask.CompletionInputJSON(task, resultJSON, s.decryptTaskInputJSON, s.encryptSettingSecret)
}
