package timelinesources

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

// ErrorKind classifies timeline source resolution failures without coupling
// this package to HTTP, operations, or task error envelopes.
type ErrorKind string

const (
	KindInvalidArg         ErrorKind = "invalid_arg"
	KindPermissionDenied   ErrorKind = "permission_denied"
	KindPreconditionFailed ErrorKind = "precondition_failed"
)

// Error describes a deterministic timeline source validation or ownership failure.
type Error struct {
	Kind    ErrorKind
	Reason  string
	Message string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// CanvasDocumentLoader loads a single owner-scoped canvas JSON document.
type CanvasDocumentLoader interface {
	UserCanvasProject(userID, canvasID string) (json.RawMessage, error)
}

// OwnedReadyResourceLookup loads an owner-scoped, ready media resource.
type OwnedReadyResourceLookup interface {
	OwnedReadyResource(userID, resourceID string) (*model.Resource, error)
}

// OwnedAssetLookup loads an owner-scoped asset record.
type OwnedAssetLookup interface {
	OwnedAsset(userID, assetID string) (*model.Asset, error)
}

// Ports supplies the narrow ownership lookups needed to authorize and resolve
// timeline clips into canonical resource references.
type Ports struct {
	Canvas    CanvasDocumentLoader
	Resources OwnedReadyResourceLookup
	Assets    OwnedAssetLookup
}

// Options configures whether canvas document membership and asset linkage are
// strictly required (agent/canvas operations) or whether owned direct media
// resources on an unsaved timeline are also accepted (direct render tasks).
type Options struct {
	RequireCanvasDocumentMembership bool
	RequireAssetLink                bool
}

// CanvasNodes extracts the top-level nodes slice from a decoded canvas document.
func CanvasNodes(doc map[string]any) []any {
	if doc == nil {
		return []any{}
	}
	if nodes, ok := doc["nodes"].([]any); ok {
		return nodes
	}
	return []any{}
}

// CollectMediaResourceIDs collects all canonical resource IDs referenced in a
// decoded canvas node or document subtree.
func CollectMediaResourceIDs(value any, ids map[string]bool) {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if key == "resourceId" {
				if id, ok := item.(string); ok && strings.TrimSpace(id) != "" {
					ids[strings.TrimSpace(id)] = true
				}
			}
			if key == "storageKey" || key == "content" {
				if raw, ok := item.(string); ok {
					if id := assets.ResourceID(raw); id != "" {
						ids[id] = true
					}
				}
			}
			CollectMediaResourceIDs(item, ids)
		}
	case []any:
		for _, item := range v {
			CollectMediaResourceIDs(item, ids)
		}
	}
}

// Resolve validates ownership and readiness for every media clip in project,
// populates canonical clip.DirectMedia storage keys (`resource:<id>`), and
// returns the matching []editing.SourceMeta list for editing.Compile.
func Resolve(userID string, doc map[string]any, project *editing.Project, ports Ports, opts Options) ([]editing.SourceMeta, error) {
	if project == nil {
		return nil, &Error{Kind: KindInvalidArg, Reason: "invalid_timeline", Message: "时间线不能为空"}
	}
	nodes := map[string]map[string]any{}
	allowed := map[string]bool{}
	assetForResource := map[string]string{}
	for _, raw := range CanvasNodes(doc) {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if id, ok := node["id"].(string); ok {
			nodes[id] = node
		}
		collectNodeResources(node, allowed, assetForResource)
	}
	if doc != nil {
		var previous editing.Project
		if raw, err := json.Marshal(doc["timeline"]); err == nil && json.Unmarshal(raw, &previous) == nil {
			for _, clip := range previous.Clips {
				if id, ok := editing.MediaResourceID(clip); ok {
					allowed[id] = true
					if clip.DirectMedia.AssetID != "" {
						assetForResource[id] = clip.DirectMedia.AssetID
					}
				}
			}
		}
	}

	sources := []editing.SourceMeta{}
	seen := map[string]bool{}
	for index := range project.Clips {
		clip := project.Clips[index]
		if clip.Kind == editing.KindSubtitle {
			continue
		}
		if clip.Kind != editing.KindVideo && clip.Kind != editing.KindImage && clip.Kind != editing.KindAudio {
			return nil, &Error{
				Kind:    KindInvalidArg,
				Reason:  "timeline_source_kind",
				Message: fmt.Sprintf("%s：%s", editing.ErrUnsupportedKind.Error(), clip.Kind),
			}
		}
		resourceID, direct := editing.MediaResourceID(clip)
		if clip.DirectMedia != nil && !direct {
			return nil, &Error{Kind: KindPermissionDenied, Reason: "timeline_source_not_authorized", Message: "时间线只接受已关联的资源引用"}
		}
		if clip.NodeID != "" {
			node, ok := nodes[clip.NodeID]
			if ok {
				ids := map[string]bool{}
				CollectMediaResourceIDs(node, ids)
				if direct {
					if !ids[resourceID] {
						return nil, &Error{Kind: KindPermissionDenied, Reason: "timeline_source_not_authorized", Message: "节点与时间线资源不一致"}
					}
				} else {
					resolved, resolvedOK := primaryNodeResourceID(node, ids)
					if !resolvedOK {
						return nil, &Error{Kind: KindInvalidArg, Reason: "timeline_resource_required", Message: "时间线节点须明确关联一个资源"}
					}
					resourceID = resolved
				}
			} else if opts.RequireCanvasDocumentMembership || !direct {
				return nil, &Error{Kind: KindPermissionDenied, Reason: "node_not_in_canvas", Message: "时间线节点不属于当前画布"}
			}
		} else if !direct {
			return nil, &Error{Kind: KindInvalidArg, Reason: "timeline_resource_required", Message: "时间线片段需要节点或资源引用"}
		}

		if opts.RequireCanvasDocumentMembership && !allowed[resourceID] {
			return nil, &Error{Kind: KindPermissionDenied, Reason: "timeline_source_not_authorized", Message: "不能在时间线中加入未关联的资源"}
		}
		if ports.Resources == nil {
			return nil, &Error{Kind: KindPreconditionFailed, Reason: "timeline_source_not_ready", Message: "时间线素材尚未就绪"}
		}
		resource, err := ports.Resources.OwnedReadyResource(userID, resourceID)
		if err != nil {
			return nil, err
		}
		if resource == nil {
			return nil, &Error{Kind: KindPreconditionFailed, Reason: "timeline_source_not_ready", Message: "时间线素材尚未就绪"}
		}

		assetID := assetForResource[resourceID]
		if !opts.RequireCanvasDocumentMembership && assetID == "" && clip.DirectMedia != nil {
			assetID = strings.TrimSpace(clip.DirectMedia.AssetID)
		}
		if opts.RequireAssetLink {
			if assetID == "" {
				return nil, &Error{Kind: KindPreconditionFailed, Reason: "timeline_asset_not_linked", Message: "素材尚未关联素材库，请先同步"}
			}
			if ports.Assets == nil {
				return nil, &Error{Kind: KindPreconditionFailed, Reason: "timeline_asset_not_linked", Message: "素材尚未关联素材库，请先同步"}
			}
			asset, assetErr := ports.Assets.OwnedAsset(userID, assetID)
			if assetErr != nil {
				return nil, assetErr
			}
			if asset == nil {
				return nil, &Error{Kind: KindPermissionDenied, Reason: "timeline_asset_not_owned", Message: "素材不属于当前工作区"}
			}
			if _, linked := assets.DocumentReferencedIDs(asset.PayloadJSON, map[string]struct{}{resourceID: {}})[resourceID]; !linked {
				return nil, &Error{Kind: KindPermissionDenied, Reason: "timeline_asset_not_linked", Message: "素材与资源引用不一致"}
			}
		}

		kind := mediaKindFromMIME(resource.MimeType)
		if kind == "" || (clip.Kind != kind && !(clip.Kind == editing.KindAudio && kind == editing.KindVideo)) {
			return nil, &Error{Kind: KindInvalidArg, Reason: "timeline_source_kind", Message: "时间线片段与素材类型不匹配"}
		}
		project.Clips[index].DirectMedia = &editing.DirectMedia{
			ID:         resourceID,
			AssetID:    assetID,
			Kind:       kind,
			StorageKey: "resource:" + resourceID,
		}
		for _, id := range []string{clip.NodeID, resourceID, "resource:" + resourceID} {
			if id != "" && !seen[id] {
				sources = append(sources, editing.SourceMeta{ID: id, Kind: kind, DurationMs: resource.DurationMs})
				seen[id] = true
			}
		}
	}
	return sources, nil
}

func collectNodeResources(node map[string]any, allowed map[string]bool, assetForResource map[string]string) {
	ids := map[string]bool{}
	CollectMediaResourceIDs(node, ids)
	for id := range ids {
		allowed[id] = true
	}
	metadata, ok := node["metadata"].(map[string]any)
	if !ok {
		return
	}
	if assetID, ok := metadata["assetId"].(string); ok && assetID != "" {
		for id := range ids {
			assetForResource[id] = assetID
		}
	}
}

func primaryNodeResourceID(node map[string]any, allIDs map[string]bool) (string, bool) {
	if len(allIDs) == 1 {
		for id := range allIDs {
			return id, true
		}
	}
	if len(allIDs) == 0 {
		return "", false
	}
	metadata, ok := node["metadata"].(map[string]any)
	if !ok {
		return "", false
	}
	primary := map[string]bool{}
	if id, ok := metadata["resourceId"].(string); ok && strings.TrimSpace(id) != "" {
		primary[strings.TrimSpace(id)] = true
	}
	for _, key := range []string{"storageKey", "content"} {
		if raw, ok := metadata[key].(string); ok {
			if id := assets.ResourceID(raw); id != "" {
				primary[id] = true
			}
		}
	}
	if len(primary) == 1 {
		for id := range primary {
			if allIDs[id] {
				return id, true
			}
		}
	}
	return "", false
}

func mediaKindFromMIME(mimeType string) string {
	normalized := strings.ToLower(strings.TrimSpace(mimeType))
	switch {
	case strings.HasPrefix(normalized, "video/"):
		return editing.KindVideo
	case strings.HasPrefix(normalized, "audio/"):
		return editing.KindAudio
	case strings.HasPrefix(normalized, "image/"):
		return editing.KindImage
	default:
		return ""
	}
}
