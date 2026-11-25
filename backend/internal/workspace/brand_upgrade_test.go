package workspace

import (
	"infinite-canvas/backend/internal/providerpreset"
	"testing"
)

func TestBrandPresetPreservesLegacyOriginAndReferences(t *testing.T) {
	cases := []struct {
		origin string
		want   string
	}{
		{"", "https://beeftv.cn"},
		{"https://legacy-enterprise.example.com", "https://beeftv.cn"},
		{"https://beeftv.cn", "https://beeftv.cn"},
		{"https://beeftv.cn/v1", "https://beeftv.cn"},
		{"https://beeftv.app", "https://beeftv.app"},
		{"https://beeftv.app/v1", "https://beeftv.app"},
	}
	for _, tc := range cases {
		channel, err := presetChannelMap(providerpreset.BeefTV(), map[string]any{"baseUrl": tc.origin, "apiKey": "stored", "models": []any{"custom-model"}})
		if err != nil {
			t.Fatal(err)
		}
		if channel["baseUrl"] != tc.want || channel["name"] != "BeefTV" || channel["id"] != "beeftv" || channel["apiKey"] != "stored" {
			t.Fatalf("migration changed channel for %q: %#v", tc.origin, channel)
		}
		if models := channel["models"].([]string); len(models) != 1 || models[0] != "custom-model" {
			t.Fatalf("models = %#v", models)
		}
	}
}
