package canvasworkflow

import "testing"

func TestCharacterReplacementOperationUsesSeparateTypedInputs(t *testing.T) {
	op := OperationByID("video.replace-character")
	if op.ID == "" || op.OutputType != "video" || len(op.Inputs) != 2 {
		t.Fatalf("missing reusable replacement operation: %+v", op)
	}
	if op.Inputs[0].ID != "video" || op.Inputs[0].MediaType != "video" || !op.Inputs[0].Required || op.Inputs[0].Multiple {
		t.Fatalf("source video must be a single required input: %+v", op.Inputs[0])
	}
	if op.Inputs[1].ID != "character" || op.Inputs[1].MediaType != "image" || !op.Inputs[1].Required || op.Inputs[1].Multiple {
		t.Fatalf("identity must be a separate required image: %+v", op.Inputs[1])
	}
}

func TestCharacterReplacementRejectsUnboundedOrDifferentModel(t *testing.T) {
	for _, config := range []map[string]any{
		{"modelOption": "beefapi::seedance-2.5"},
		{"modelOption": "beefapi::seedance-2.0-fast", "maxSegments": 0},
		{"modelOption": "beefapi::seedance-2.0-fast", "maxSegments": 101},
		{"modelOption": "beefapi::seedance-2.0-fast", "maxSegments": 1.5},
	} {
		if err := ValidateOperation(Node{ID: "replace", MediaType: "video", OperationID: "video.replace-character", OperationVersion: 1, Config: config}); err == nil {
			t.Fatalf("accepted unsafe replacement config: %+v", config)
		}
	}
	for _, valid := range []string{"beefapi::seedance-2.0-fast", "ark::doubao-seedance-2-0-fast-260128", "ark::dreamina-seedance-2-0-fast"} {
		if err := ValidateOperation(Node{ID: "replace", MediaType: "video", OperationID: "video.replace-character", OperationVersion: 1, Config: map[string]any{"modelOption": valid}}); err != nil {
			t.Fatalf("valid fast operation %q rejected: %v", valid, err)
		}
	}
}

func TestResolveReplacementCapabilityFailsClosedAndRespectsBounds(t *testing.T) {
	if _, ok := ResolveReplacementCapability("", "", nil); ok {
		t.Fatal("accepted empty protocol/model with nil capability")
	}
	if _, ok := ResolveReplacementCapability("volcengine-ark-video", "ep-custom-2-5", nil); ok {
		t.Fatal("accepted arbitrary custom endpoint with nil capabilityConfig")
	}
	if _, ok := ResolveReplacementCapability("newapi-channel-2", "arbitrary-video-model", nil); ok {
		t.Fatal("accepted arbitrary NewAPI model with nil capabilityConfig")
	}
	if _, ok := ResolveReplacementCapability("volcengine-ark-video", "custom-model", "not-an-object"); ok {
		t.Fatal("accepted malformed capabilityConfig")
	}
	if _, ok := ResolveReplacementCapability("volcengine-ark-video", "custom-model", map[string]any{"video": nil}); ok {
		t.Fatal("accepted missing video capability")
	}
	// Reject models requiring >= 2 reference images (single-character replacement supplies 1).
	minImagesTwo := map[string]any{
		"video": map[string]any{
			"operations":  []string{"reference_to_video"},
			"resolutions": []string{"720p"},
			"duration":    map[string]any{"selection": "range", "min": 4, "max": 12, "default": 5},
			"references":  map[string]any{"minImages": 2, "maxImages": 4, "maxVideos": 1},
		},
	}
	if _, ok := ResolveReplacementCapability("volcengine-ark-video", "two-image-model", minImagesTwo); ok {
		t.Fatal("accepted model requiring minImages=2")
	}

	customCap := map[string]any{
		"video": map[string]any{
			"operations":  []string{"text_to_video", "reference_to_video"},
			"resolutions": []string{"480p"},
			"duration":    map[string]any{"selection": "range", "min": 4, "max": 10, "default": 5},
			"references": map[string]any{
				"minImages":               1,
				"maxImages":               2,
				"maxImageBytes":           8 * 1024 * 1024,
				"maxVideos":               1,
				"maxVideoBytes":           20 * 1024 * 1024,
				"minVideoDurationSeconds": 4,
				"maxVideoDurationSeconds": 10,
				"minVideoAspect":          0.5,
				"maxVideoAspect":          2.0,
			},
		},
	}
	lim, ok := ResolveReplacementCapability("volcengine-ark-video", "custom-ref-video", customCap)
	if !ok || lim.MinSeconds != 4 || lim.MaxSeconds != 10 || lim.MinRefSeconds != 4 || lim.DefaultQuality != "480p" || lim.SupportsQuality("720p") || !lim.SupportsQuality("480p") || lim.MaxVideoBytes != 20*1024*1024 || lim.MaxImageBytes != 8*1024*1024 || lim.MaxVideoAspect != 2.0 {
		t.Fatalf("unexpected custom capability bounds: %+v ok=%v", lim, ok)
	}
	// Wide 21:9 (2.33 > 2.0) must be rejected by custom MaxVideoAspect.
	if _, err := PlanCharacterReplacement(2100, 900, 30, 120, nil, 12, lim); err == nil {
		t.Fatal("accepted aspect ratio exceeding custom MaxVideoAspect=2.0")
	}
	// Short 1s clip must pad reference to MinRefSeconds=4s (120 frames at 30fps).
	shortPlan, err := PlanCharacterReplacement(720, 1280, 30, 30, nil, 12, lim)
	if err != nil || shortPlan.Segments[0].ReferenceFrames != 120 {
		t.Fatalf("expected MinRefSeconds=4 (120 frames), got %+v err=%v", shortPlan, err)
	}
	plan, err := PlanCharacterReplacement(720, 1280, 30, 420, nil, 12, lim)
	if err != nil {
		t.Fatalf("PlanCharacterReplacement with 4..10s failed: %v", err)
	}
	for _, seg := range plan.Segments {
		if seg.GenerationSeconds < 4 || seg.GenerationSeconds > 10 {
			t.Fatalf("segment exceeded 10s model cap: %+v", seg)
		}
	}
	// Exact maxSec intermediate cuts (5s, 10s, 15s) and context-overlap boundaries must never exceed maxSec.
	for _, maxS := range []int{5, 10, 15} {
		bound := DefaultReplacementLimits()
		bound.MinSeconds, bound.MaxSeconds = 4, maxS
		for _, cuts := range [][]int{{maxS * 30, 2 * maxS * 30}, nil} {
			gotPlan, err := PlanCharacterReplacement(1280, 720, 30, 3*maxS*30-4, cuts, 20, bound)
			if err != nil {
				t.Fatalf("maxSec=%d cuts=%v failed: %v", maxS, cuts, err)
			}
			for _, seg := range gotPlan.Segments {
				if seg.ReferenceFrames > maxS*30 || seg.GenerationSeconds > maxS {
					t.Fatalf("maxSec=%d segment exceeded cap: %+v", maxS, seg)
				}
			}
		}
	}
	// Axis-aware scaling: 1280x720..1920x1080 must keep 1920x1080 within >=1280x720.
	hdLim := DefaultReplacementLimits()
	hdLim.MinVideoWidth, hdLim.MinVideoHeight = 1280, 720
	hdLim.MaxVideoWidth, hdLim.MaxVideoHeight = 1920, 1080
	rw, rh, err := hdLim.ReferenceScaleDimensions(1920, 1080)
	if err != nil || rw < 1280 || rw > 1920 || rh < 720 || rh > 1080 {
		t.Fatalf("1920x1080 scaled out of 1280x720..1920x1080 bounds: %dx%d err=%v", rw, rh, err)
	}
}
