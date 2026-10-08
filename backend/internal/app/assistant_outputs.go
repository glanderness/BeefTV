package app

import (
	"errors"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// AssistantOutput identifies an admitted local render. Ready/failed state and
// playable resources still come from the existing owned task API.
type AssistantOutput struct {
	TaskID         string `json:"taskId"`
	Kind           string `json:"kind"`
	SourceRevision *int64 `json:"sourceRevision,omitempty"`
}

func (s *Service) AssistantTurnOutputs(userID, canvasID, turnID string) ([]AssistantOutput, error) {
	outputs := []AssistantOutput{}
	refs, err := s.assistantTurnsOrInit().RenderOutputRefs(userID, canvasID, turnID)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		task, err := s.Task(userID, ref.TaskID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if task.Type != model.TaskTypeTimelineRender || task.Provider != "local" || task.UserID != userID || task.ProjectID != ref.CanvasID || task.ClientOperationID == nil || *task.ClientOperationID != "assistant-render:"+ref.OperationID || seen[task.ID] {
			continue
		}
		if _, err := s.UserCanvasProject(userID, ref.CanvasID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return nil, err
		}
		seen[task.ID] = true
		outputs = append(outputs, AssistantOutput{TaskID: task.ID, Kind: "video", SourceRevision: ref.SourceRevision})
	}
	return outputs, nil
}
