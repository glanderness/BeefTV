package app

import (
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) captureCanvasWorkflowSource(task model.Task) (string, error) {
	return cw.CaptureSource(s.compileHost(), task)
}
