package app

import "infinite-canvas/backend/internal/modelcatalog"

// Reuse the public catalog projection; execution configuration and keys are not returned.
func (s *operationSession) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	return s.service.ModelCatalog(nil)
}
