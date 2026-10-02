package canvas

import (
	"encoding/json"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type MediaAssetReference = asset.CanvasMediaReference

// validateCanvasMediaAssets is the final server-side invariant for canvas sync:
// a persisted canvas may only point at an uploaded Resource through an Asset
// owned by the same user. The client writes Assets before canvases, so rejecting
// an incomplete pair prevents a durable Resource-only (ghost capacity) state.
func (s *Service) ValidateCanvasMediaAssets(userID string, raw json.RawMessage) error {
	return s.validateCanvasMediaAssetsWithCandidates(userID, raw, nil)
}

func (s *Service) validateCanvasMediaAssetsWithCandidates(userID string, raw json.RawMessage, candidates []model.Asset) error {
	references, err := MediaAssetReferences(raw)
	if err != nil {
		return kernel.BadAuthRequest("画布媒体数据格式错误")
	}
	if len(references) == 0 {
		return nil
	}

	assetIDSet := make(map[string]struct{}, len(references))
	resourceIDSet := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if reference.AssetID == "" {
			return kernel.BadAuthRequest("画布媒体尚未进入素材库，请等待同步完成后重试")
		}
		assetIDSet[reference.AssetID] = struct{}{}
		resourceIDSet[reference.ResourceID] = struct{}{}
	}

	ownedAssets, err := s.repo.AssetsForUserIDs(userID, assets.SortedIDs(assetIDSet))
	if err != nil {
		return err
	}
	assetResources := make(map[string]map[string]struct{}, len(ownedAssets))
	for _, asset := range ownedAssets {
		assetResources[asset.ID] = assets.DocumentReferencedIDs(asset.PayloadJSON, resourceIDSet)
	}
	for _, asset := range candidates {
		if asset.UserID == userID {
			assetResources[asset.ID] = assets.DocumentReferencedIDs(asset.PayloadJSON, resourceIDSet)
		}
	}

	resources, err := s.repo.ResourcesForUserIDs(userID, assets.SortedIDs(resourceIDSet))
	if err != nil {
		return err
	}
	readyResources := make(map[string]struct{}, len(resources))
	for _, resource := range resources {
		if resource.Status == model.ResourceStatusReady {
			readyResources[resource.ID] = struct{}{}
		}
	}

	for _, reference := range references {
		if _, exists := readyResources[reference.ResourceID]; !exists {
			return kernel.BadAuthRequest("画布媒体对应的资源不存在或尚未就绪，请重新上传")
		}
		resourceIDs, assetExists := assetResources[reference.AssetID]
		if !assetExists {
			return kernel.BadAuthRequest("画布媒体尚未进入素材库，请等待同步完成后重试")
		}
		if _, matches := resourceIDs[reference.ResourceID]; !matches {
			return kernel.BadAuthRequest("画布媒体与素材库记录不一致，请重新同步")
		}
	}
	return nil
}

// BindCanvasMediaAssets fills missing/stale asset bindings from candidate
// assets by exact Resource identity. It never guesses from titles or URLs.
func BindCanvasMediaAssets(raw json.RawMessage, candidates []model.Asset) (json.RawMessage, error) {
	byResource := map[string]string{}
	for _, asset := range candidates {
		ids := map[string]struct{}{}
		if err := assets.CollectOwnedDocumentReferences(asset.PayloadJSON, ids); err != nil {
			return nil, err
		}
		for resourceID := range ids {
			if existing, found := byResource[resourceID]; found && existing != asset.ID {
				delete(byResource, resourceID)
				continue
			}
			byResource[resourceID] = asset.ID
		}
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(document["nodes"], &nodes); err != nil && len(document["nodes"]) > 0 {
		return nil, err
	}
	for _, node := range nodes {
		var kind string
		_ = json.Unmarshal(node["type"], &kind)
		if !isCanvasMediaKind(kind) {
			continue
		}
		var metadata map[string]json.RawMessage
		if json.Unmarshal(node["metadata"], &metadata) != nil {
			continue
		}
		var storageKey, content string
		_ = json.Unmarshal(metadata["storageKey"], &storageKey)
		_ = json.Unmarshal(metadata["content"], &content)
		if assetID := byResource[firstCanvasResourceID(storageKey, content)]; assetID != "" {
			metadata["assetId"], _ = json.Marshal(assetID)
			node["metadata"], _ = json.Marshal(metadata)
		}
	}
	document["nodes"], _ = json.Marshal(nodes)
	return json.Marshal(document)
}

// validateAssetCanvasReferences prevents an Asset update from changing the
// resource behind a canvas that already points at that Asset.
func (s *Service) ValidateAssetCanvasReferences(userID string, item model.Asset) error {
	return s.Library().GuardCanvasReferences(userID, item)
}

// validateAssetReplacementCanvasReferences applies the same invariant to the
// legacy full-replacement endpoint, which otherwise could silently remove an
// Asset that a canvas still needs.
func (s *Service) ValidateAssetReplacementCanvasReferences(userID string, replacement []model.Asset) error {
	return s.Library().GuardReplacementCanvasReferences(userID, replacement)
}

func MediaAssetReferences(raw json.RawMessage) ([]MediaAssetReference, error) {
	return asset.CanvasMediaReferences(raw)
}

func firstCanvasResourceID(values ...string) string {
	for _, value := range values {
		if resourceID := assets.ResourceID(value); resourceID != "" {
			return resourceID
		}
	}
	return ""
}

func isCanvasMediaKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image", "video", "audio":
		return true
	default:
		return false
	}
}
