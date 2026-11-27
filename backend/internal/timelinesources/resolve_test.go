package timelinesources

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

type stubLookup struct {
	resources map[string]*model.Resource
	assets    map[string]*model.Asset
}

func (s stubLookup) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	res := s.resources[userID+":"+resourceID]
	if res == nil {
		return nil, &Error{Kind: KindPermissionDenied, Reason: "resource_foreign", Message: "forbidden"}
	}
	return res, nil
}

func (s stubLookup) OwnedAsset(userID, assetID string) (*model.Asset, error) {
	asset := s.assets[userID+":"+assetID]
	if asset == nil {
		return nil, &Error{Kind: KindPermissionDenied, Reason: "asset_foreign", Message: "forbidden"}
	}
	return asset, nil
}

func TestResolveDisambiguatesPrimaryNodeResourceOverPosterPreview(t *testing.T) {
	doc := map[string]any{
		"nodes": []any{
			map[string]any{
				"id":   "video-node",
				"type": "video",
				"metadata": map[string]any{
					"storageKey": "resource:res-video",
					"assetId":    "asset-video",
					"videoPreview": map[string]any{
						"storageKey": "resource:res-poster",
					},
				},
			},
			map[string]any{
				"id":   "image-node",
				"type": "image",
				"metadata": map[string]any{
					"storageKey": "resource:res-img",
					"assetId":    "asset-img",
				},
			},
		},
	}
	lookup := stubLookup{
		resources: map[string]*model.Resource{
			"owner:res-video": {ID: "res-video", MimeType: "video/mp4", DurationMs: 5000, Status: model.ResourceStatusReady},
			"owner:res-img":   {ID: "res-img", MimeType: "image/png", Status: model.ResourceStatusReady},
		},
		assets: map[string]*model.Asset{
			"owner:asset-video": {ID: "asset-video", UserID: "owner", PayloadJSON: `{"storageKey":"resource:res-video"}`},
			"owner:asset-img":   {ID: "asset-img", UserID: "owner", PayloadJSON: `{"storageKey":"resource:res-img"}`},
		},
	}
	project := editing.Project{
		Version:    2,
		DurationMs: 4000,
		Tracks:     []editing.Track{{ID: "v", Kind: editing.KindVideo}},
		Clips: []editing.Clip{
			{ID: "c1", Kind: editing.KindVideo, NodeID: "video-node", TrackID: "v", StartMs: 0, DurationMs: 2000, Volume: 1},
			{ID: "c2", Kind: editing.KindImage, NodeID: "image-node", TrackID: "v", StartMs: 2000, DurationMs: 2000, Volume: 1},
		},
	}

	sources, err := Resolve("owner", doc, &project, Ports{Resources: lookup, Assets: lookup}, Options{
		RequireCanvasDocumentMembership: true,
		RequireAssetLink:                true,
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if project.Clips[0].DirectMedia == nil || project.Clips[0].DirectMedia.StorageKey != "resource:res-video" {
		t.Fatalf("video clip directMedia = %+v, want resource:res-video", project.Clips[0].DirectMedia)
	}
	if project.Clips[1].DirectMedia == nil || project.Clips[1].DirectMedia.StorageKey != "resource:res-img" {
		t.Fatalf("image clip directMedia = %+v, want resource:res-img", project.Clips[1].DirectMedia)
	}
	plan, err := editing.Compile(project, sources, editing.Options{Width: 1080, Height: 1920})
	if err != nil {
		t.Fatalf("Compile() error = %v", err)
	}
	if len(plan.Segments) != 2 || plan.Segments[0].Kind != editing.KindVideo || plan.Segments[1].Kind != editing.KindImage {
		t.Fatalf("unexpected segments: %+v", plan.Segments)
	}
}

func TestResolveRejectsForeignNodeAndAllowsUnsavedOwnedDirectMediaInRenderMode(t *testing.T) {
	doc := map[string]any{"nodes": []any{}}
	lookup := stubLookup{
		resources: map[string]*model.Resource{
			"owner:res-local": {ID: "res-local", MimeType: "audio/mp4", DurationMs: 3000, Status: model.ResourceStatusReady},
		},
	}

	unsavedLocal := editing.Project{
		Version:    2,
		DurationMs: 2000,
		Tracks:     []editing.Track{{ID: "a", Kind: editing.KindAudio}},
		Clips: []editing.Clip{{
			ID:          "clip-local",
			Kind:        editing.KindAudio,
			NodeID:      "timeline-media-audio-1",
			TrackID:     "a",
			StartMs:     0,
			DurationMs:  2000,
			Volume:      1,
			DirectMedia: &editing.DirectMedia{ID: "audio-1", Kind: editing.KindAudio, StorageKey: "resource:res-local"},
		}},
	}
	if _, err := Resolve("owner", doc, &unsavedLocal, Ports{Resources: lookup}, Options{}); err != nil {
		t.Fatalf("render mode rejected owned directMedia on empty canvas: %v", err)
	}
	if _, err := Resolve("owner", doc, &unsavedLocal, Ports{Resources: lookup}, Options{RequireCanvasDocumentMembership: true}); err == nil {
		t.Fatal("strict mode accepted unsaved directMedia not in canvas")
	}

	foreignNode := editing.Project{
		Version:    2,
		DurationMs: 2000,
		Tracks:     []editing.Track{{ID: "v", Kind: editing.KindVideo}},
		Clips: []editing.Clip{{
			ID: "clip-foreign", Kind: editing.KindVideo, NodeID: "missing-node", TrackID: "v", StartMs: 0, DurationMs: 2000, Volume: 1,
		}},
	}
	_, err := Resolve("owner", doc, &foreignNode, Ports{Resources: lookup}, Options{})
	var tsErr *Error
	if !errors.As(err, &tsErr) || tsErr.Kind != KindPermissionDenied || tsErr.Reason != "node_not_in_canvas" {
		t.Fatalf("err = %v, want permission denied node_not_in_canvas", err)
	}
}
