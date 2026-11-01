package app

import (
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func captureTaskFailureDiagnostics(task *model.Task, err error, source string) {
	generation.CaptureTaskFailureDiagnostics(task, err, source)
}
