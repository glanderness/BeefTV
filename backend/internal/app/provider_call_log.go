package app

import (
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) EnrichAPICallLog(log *model.ApiCallLog, responseBody []byte) {
	generation.EnrichAPICallLog(log, responseBody)
}
