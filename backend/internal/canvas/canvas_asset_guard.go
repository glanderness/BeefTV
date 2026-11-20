package canvas

import (
	"encoding/json"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
)

type MediaAssetReference = asset.CanvasMediaReference

// ValidateAssetCanvasReferences prevents an Asset update from changing the
// resource behind a canvas that already points at that Asset.
func (s *Service) ValidateAssetCanvasReferences(userID string, item model.Asset) error {
	return s.Library().GuardCanvasReferences(userID, item)
}

// ValidateAssetReplacementCanvasReferences applies the same invariant to the
// legacy full-replacement endpoint, which otherwise could silently remove an
// Asset that a canvas still needs.
func (s *Service) ValidateAssetReplacementCanvasReferences(userID string, replacement []model.Asset) error {
	return s.Library().GuardReplacementCanvasReferences(userID, replacement)
}

func MediaAssetReferences(raw json.RawMessage) ([]MediaAssetReference, error) {
	return asset.CanvasMediaReferences(raw)
}
