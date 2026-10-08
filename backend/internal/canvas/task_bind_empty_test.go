package canvas

import (
	"encoding/json"
	"testing"
)

func TestEmptyRenderBindingRequiresTrustedFlagAndEmptyVideo(t *testing.T) {
	patch := TaskOutputBind{AllowEmptyVideo: true, MediaType: "video"}
	for _, tc := range []struct {
		name  string
		node  map[string]any
		allow bool
	}{
		{"empty video", map[string]any{"type": "video"}, true},
		{"other node", map[string]any{"type": "image"}, false},
		{"old task", map[string]any{"type": "video", "metadata": map[string]any{"taskId": "old"}}, false},
		{"old media", map[string]any{"type": "video", "content": "resource:old"}, false},
		{"asset", map[string]any{"type": "video", "metadata": map[string]any{"assetId": "old"}}, false},
		{"unexpected map", map[string]any{"type": "video", "content": map[string]any{}}, false},
		{"unexpected slice", map[string]any{"type": "video", "metadata": map[string]any{"storageKey": []any{}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := canBindEmptyRenderNode(tc.node, patch); got != tc.allow {
				t.Fatalf("got %v want %v", got, tc.allow)
			}
		})
	}
	patch.AllowEmptyVideo = false
	if canBindEmptyRenderNode(map[string]any{"type": "video"}, patch) {
		t.Fatal("untrusted patch allowed")
	}
	if err := json.Unmarshal([]byte(`{"AllowEmptyVideo":true}`), &patch); err != nil {
		t.Fatal(err)
	}
	if patch.AllowEmptyVideo {
		t.Fatal("internal flag accepted from JSON")
	}
}
