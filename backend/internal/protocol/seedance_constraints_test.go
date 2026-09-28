package protocol

import (
	"context"
	"testing"
)

func TestSeedanceInstalledPluginsSendAdaptive(t *testing.T) {
	for _, tc := range []struct{ file, id, ratioKey string }{
		{"volcengine-ark-seedance.beeftv-plugin", "volcengine-ark-video", "ratio"},
		{"volcengine-ark-agent-plan-seedance.beeftv-plugin", "volcengine-ark-agent-plan-video", "ratio"},
		{"seedance-videos-compatible.beeftv-plugin", "seedance-videos-compatible", "aspect_ratio"},
	} {
		a := officialPackageAdapter(t, tc.file, tc.id)
		spec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Capability: CapabilityVideo, Model: "seedance-2.5-official", Prompt: "move", AspectRatio: "9:16", Duration: 6, Images: []MediaReference{{URL: "https://example.com/first.png", Role: "first_frame"}}}})
		if err != nil {
			t.Fatal(err)
		}
		if body := manifestTestBody(t, spec); body[tc.ratioKey] != "adaptive" {
			t.Fatalf("%s sent wrong ratio: %#v", tc.id, body)
		}
	}
}

func TestSeedanceTaskConstraints(t *testing.T) {
	for _, tc := range []struct {
		name, model, role, operation, ratio string
		videos, duration                    int
	}{
		{"official first frame", "seedance-2.5-official", "first_frame", "", "adaptive", 0, 6},
		{"native last frame", "doubao-seedance-2-5-260628", "last_frame", "", "adaptive", 0, 6},
		{"reference image", "seedance-2.5", "reference_image", "reference_to_video", "9:16", 0, 6},
		{"reference video", "seedance-2.5", "", "reference_to_video", "9:16", 1, 6},
		{"edit", "seedance-2.5", "", "inpaint", "adaptive", 1, -1},
		{"extend", "seedance-2.5", "", "extend", "adaptive", 1, 6},
		{"no video edit", "seedance-2.5", "", "inpaint", "9:16", 0, 6},
		{"2.0 unaffected", "seedance-2.0-fast", "first_frame", "", "9:16", 0, 6},
		{"unrelated model", "other-model", "first_frame", "", "9:16", 0, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := GenerationRequest{Model: tc.model, Prompt: "edit this video", AspectRatio: "9:16", Duration: 6, Operation: tc.operation, Images: []MediaReference{{Role: tc.role}}, Videos: make([]MediaReference, tc.videos)}
			got := NormalizeSeedanceTaskOptions(r)
			if got.AspectRatio != tc.ratio || got.Duration != tc.duration {
				t.Fatalf("got ratio=%s duration=%d", got.AspectRatio, got.Duration)
			}
		})
	}
}
