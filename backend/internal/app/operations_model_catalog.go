package app

import (
	"context"
	"errors"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/modelcatalog"
)

// Desktop execution uses its provider snapshot, not hosted database channels.
// The public sanitizer excludes execution addresses, headers and credentials.
func (s *operationSession) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	if !s.service.IsLocalMode() {
		return s.service.ModelCatalog(nil)
	}
	body, err := s.service.ReadLocalModelConfig()
	if err != nil {
		return nil, err
	}
	return modelcatalog.PublicCatalogFromLocalSnapshot(body, s.service.PluginDomain().LookupWorkflow)
}

func (s *operationSession) EstimateServerPricing(ctx context.Context, req beeftv.PricingEstimateRequest) (beeftv.PricingEstimateResponse, error) {
	if s.service == nil || s.service.beefTV == nil || !s.service.beefTV.HasManagedCredential() {
		return beeftv.PricingEstimateResponse{}, errors.New("beeftv connection unavailable")
	}
	return s.service.beefTV.EstimatePricing(ctx, req)
}
