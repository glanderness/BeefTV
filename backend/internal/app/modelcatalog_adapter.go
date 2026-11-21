package app

import (
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/modelcatalog"
)

func taskInputFromCanvas(input canvasGenerationInput) modelcatalog.TaskInput {
	return generation.TaskInputFromCanvas(input)
}
