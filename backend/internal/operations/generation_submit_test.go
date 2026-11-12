package operations

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/modelcatalog"
)

type mixedGenerationProbe struct {
	proposeProbe
	admitted []GenerationTarget
}

func (p *mixedGenerationProbe) SubmitAuthorizedGeneration(_, _, _ string, targets []GenerationTarget) (any, error) {
	p.admitted = targets
	return map[string]any{"taskIds": []string{"video-task", "voice-task"}}, nil
}

func TestGenerationSubmitMixedReadyTargetsAndDependencyRejection(t *testing.T) {
	for _, pending := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "pending-reference"}[pending], func(t *testing.T) {
			frame := imageNode("frame", "image")
			if !pending {
				frame["metadata"].(map[string]any)["storageKey"] = "resource:frame"
			}
			video := imageNode("video", "video")
			video["type"] = "video"
			video["metadata"].(map[string]any)["videoStartFrameNodeId"] = "frame"
			voice := imageNode("voice", "speech")
			voice["type"] = "audio"
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{frame, video, voice})}}
			p.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["video","voice"]}`))
			if pending {
				if err == nil || len(p.admitted) != 0 {
					t.Fatal("unready dependency admitted paid work", err)
				}
			} else if err != nil || len(p.admitted) != 2 || p.admitted[0].Kind != "video" || p.admitted[1].Kind != "audio" {
				t.Fatalf("mixed admission: %+v %v", p.admitted, err)
			}
		})
	}
}

func TestProductionSeedreamUnsupportedOutputsNeverReachAdmission(t *testing.T) {
	for _, tc := range []struct{ name, model, mode, max string }{
		{"layers", "custom::dola-seedream-5-0-pro-260128", "layers", "1"},
		{"flash-layers", "dola-seedream-5-0-flash-260128", "layers", "1"},
		{"group", "custom::seedream-4-5-251128", "image", "4"},
		{"lite-group", "custom::seedream-5-0-260128", "image", "2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := imageNode("image", tc.model)
			meta := n["metadata"].(map[string]any)
			meta["seedreamMode"], meta["seedreamMaxImages"] = tc.mode, tc.max
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{n})}}
			p.resolve = func(_, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{Display: selected, ModelKey: selected}, nil
			}
			for _, propose := range []bool{true, false} {
				var result any
				var err error
				ctx := &Context{TurnID: "turn", UserID: "owner", Domain: p}
				if propose {
					result, err = opCanvasGenerationPropose(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"],"kind":"image","productionNodeIds":["image"]}`))
				} else {
					result, err = opGenerationSubmit(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"]}`))
				}
				if err == nil || AsError(err).Reason != "production_seedream_multiple_outputs" || result != nil || len(p.admitted) != 0 {
					t.Fatalf("unsupported combination reached paid admission (propose=%v): result=%v targets=%+v err=%v", propose, result, p.admitted, err)
				}
			}
		})
	}
}

func TestProductionSeedreamSingleImageKeepsConfirmedOptions(t *testing.T) {
	for _, model := range []string{"custom::seedream-5-0-260128", "custom::dola-seedream-5-0-pro-260128", "custom::other-image"} {
		t.Run(model, func(t *testing.T) {
			n := imageNode("image", model)
			meta := n["metadata"].(map[string]any)
			options := map[string]string{"seedreamMode": "image", "seedreamMaxImages": "1", "seedreamOutputFormat": "jpeg", "seedreamOptimize": "fast", "seedreamWatermark": "true"}
			for k, v := range options {
				meta[k] = v
			}
			if model == "custom::other-image" {
				meta["seedreamMode"], meta["seedreamMaxImages"] = "layers", "4"
			}
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{n})}}
			p.resolve = func(_, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"]}`))
			if err != nil || len(p.admitted) != 1 {
				t.Fatalf("single-image admission: %+v %v", p.admitted, err)
			}
			for k, v := range options {
				want := v
				if model == "custom::other-image" {
					want = ""
				}
				if got := p.admitted[0].Parameters[k]; got != want {
					t.Fatalf("confirmed %s changed: got %q want %q", k, got, want)
				}
			}
		})
	}
}

type catalogGenerationProbe struct {
	mixedGenerationProbe
	catalog *modelcatalog.CatalogResponse
}

func (p *catalogGenerationProbe) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	return p.catalog, nil
}

func TestGenerationTargetsReconcilesStaleVideoOperationWithModelCapabilities(t *testing.T) {
	wanCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 10, "maxVideos": 5, "maxAudios": 5},
			"operationReferences": map[string]any{
				"image_to_video":     map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 0},
				"reference_to_video": map[string]any{"maxImages": 10, "maxVideos": 5, "maxAudios": 5},
			},
		},
	}
	klingCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video"},
			"references":       map[string]any{"maxImages": 1, "maxVideos": 0, "maxAudios": 0},
		},
	}
	h3Cap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
		},
	}
	catalog := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, []modelcatalog.PublicChannelCatalog{{
		ID: "beeftv",
		Models: []modelcatalog.PublicChannelModel{
			{ID: "wan3.0-video", ModelKey: "wan3.0-video", Capability: "video", Available: true, CapabilityConfig: wanCap},
			{ID: "kling-video-v3", ModelKey: "kling-video-v3", Capability: "video", Available: true, CapabilityConfig: klingCap},
			{ID: "minimax-h3-max", ModelKey: "minimax-h3-max", Capability: "video", Available: true, CapabilityConfig: h3Cap},
		},
	}})

	img1 := imageNode("img-1", "image")
	img1["metadata"].(map[string]any)["storageKey"] = "resource:img-1"
	img2 := imageNode("img-2", "image")
	img2["metadata"].(map[string]any)["storageKey"] = "resource:img-2"
	img3 := imageNode("img-3", "image")
	img3["metadata"].(map[string]any)["storageKey"] = "resource:img-3"
	aud1 := imageNode("aud-1", "audio")
	aud1["type"] = "audio"
	aud1["metadata"].(map[string]any)["storageKey"] = "resource:aud-1"

	wanVideo := imageNode("wan-shot", "beeftv::wan3.0-video")
	wanVideo["type"] = "video"
	wanVideo["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	wanVideo["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	klingVideo := imageNode("kling-shot", "beeftv::kling-video-v3")
	klingVideo["type"] = "video"
	klingVideo["metadata"].(map[string]any)["videoEditOperation"] = "reference_to_video"

	h3FrameAudio := imageNode("h3-lip-shot", "beeftv::minimax-h3-max")
	h3FrameAudio["type"] = "video"
	h3FrameAudio["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	h3FrameAudio["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	h3MidFrame := imageNode("h3-mid-shot", "beeftv::minimax-h3-max")
	h3MidFrame["type"] = "video"
	h3MidFrame["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	h3MidFrame["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	h3MidFrame["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	h3MidFrame["metadata"].(map[string]any)["videoEndFrameNodeId"] = "img-3"
	h3MidFrame["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5

	doc := map[string]any{
		"nodes": []any{img1, img2, img3, aud1, wanVideo, klingVideo, h3FrameAudio, h3MidFrame},
		"connections": []any{
			map[string]any{"fromNodeId": "img-1", "toNodeId": "wan-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "wan-shot"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "wan-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "kling-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "h3-lip-shot"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "h3-lip-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "h3-mid-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "h3-mid-shot"},
			map[string]any{"fromNodeId": "img-3", "toNodeId": "h3-mid-shot"},
		},
	}

	probe := &catalogGenerationProbe{
		mixedGenerationProbe: mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{img1, img2, img3, aud1, wanVideo, klingVideo, h3FrameAudio, h3MidFrame})}},
		catalog:              &catalog,
	}
	probe.resolve = func(_, selected string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{ModelKey: selected, Display: selected}, nil
	}

	targets, err := GenerationTargets(probe, doc, []string{"wan-shot", "kling-shot", "h3-lip-shot", "h3-mid-shot"})
	if err != nil {
		t.Fatalf("GenerationTargets error: %v", err)
	}
	if len(targets) != 4 {
		t.Fatalf("len(targets) = %d, want 4", len(targets))
	}
	if got := targets[0].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("wan-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := targets[0].Parameters["videoStartFrameNodeId"]; got != "" {
		t.Fatalf("wan-shot stale videoStartFrameNodeId not cleared: %q", got)
	}
	if got := targets[1].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("kling-shot videoEditOperation = %v, want image_to_video", got)
	}
	if got := targets[2].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("h3-lip-shot videoEditOperation = %v, want image_to_video", got)
	}
	if got := targets[2].Parameters["videoStartFrameNodeId"]; got != "img-1" {
		t.Fatalf("h3-lip-shot videoStartFrameNodeId = %q, want img-1", got)
	}
	if got := targets[3].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("h3-mid-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := targets[3].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("h3-mid-shot videoMiddleFrameNodeId = %q, want img-2", got)
	}
}
