package modelcatalog

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestCapabilityNormalizerProjectsPluginWorkflowCapabilities(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "autodl-comfyui.beeftv-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		t.Fatal(err)
	}
	normalizer := NewCapabilityNormalizer(func(providerID string, capability protocol.Capability, modelID string) (protocol.ManifestWorkflow, bool) {
		for _, workflow := range pkg.Manifest.Contributes.Workflows {
			if strings.EqualFold(workflow.ProviderID, providerID) && workflow.Capability == capability && strings.EqualFold(workflow.ID, modelID) {
				return workflow, true
			}
		}
		return protocol.ManifestWorkflow{}, false
	})

	cases := []struct {
		model         string
		resolutions   []string
		defaultRes    string
		maxSeconds    int
		defaultSecond int
	}{
		{
			model:         "minimax_h3_b99_003_12s",
			resolutions:   []string{"736p竖", "736p横", "736p(1:1)"},
			defaultRes:    "736p竖",
			maxSeconds:    12,
			defaultSecond: 5,
		},
		{
			model:         "minimax_h3_lightx2v_v5",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"},
			defaultRes:    "768p竖",
			maxSeconds:    10,
			defaultSecond: 5,
		},
		{
			model:         "minimax_h3_image_audio_to_video",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"},
			defaultRes:    "768p竖",
			maxSeconds:    15,
			defaultSecond: 5,
		},
	}

	for _, tc := range cases {
		cfg, err := normalizer.NormalizeModelCapabilityDraft(ModelCapabilityDraft{
			Model:      tc.model,
			Capability: "video",
			Protocol:   "autodl-comfyui",
		})
		if err != nil {
			t.Fatalf("%s normalize error: %v", tc.model, err)
		}
		if cfg == nil || cfg.Video == nil {
			t.Fatalf("%s missing video config: %#v", tc.model, cfg)
		}
		if len(cfg.Video.Ratios) != 0 || cfg.Video.DefaultRatio != "" {
			t.Fatalf("%s ratios = %#v (default %q), want empty", tc.model, cfg.Video.Ratios, cfg.Video.DefaultRatio)
		}
		if !slices.Equal(cfg.Video.Resolutions, tc.resolutions) || cfg.Video.DefaultResolution != tc.defaultRes {
			t.Fatalf("%s resolutions = %#v (default %q), want %#v (%q)", tc.model, cfg.Video.Resolutions, cfg.Video.DefaultResolution, tc.resolutions, tc.defaultRes)
		}
		if cfg.Video.Duration.Selection != "range" || cfg.Video.Duration.Min != 1 || cfg.Video.Duration.Max != tc.maxSeconds || cfg.Video.Duration.Default != tc.defaultSecond {
			t.Fatalf("%s duration = %#v, want range 1..%d default %d", tc.model, cfg.Video.Duration, tc.maxSeconds, tc.defaultSecond)
		}
	}
}
