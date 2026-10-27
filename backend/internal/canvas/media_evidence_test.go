package canvas

import "testing"

func TestNodeHasBindingOccupancyIncludesTextAndTopLevelFields(t *testing.T) {
	for _, test := range []struct {
		name string
		node map[string]any
		want bool
	}{
		{name: "metadata content", node: map[string]any{"metadata": map[string]any{"content": "existing-result"}}, want: true},
		{name: "top-level task", node: map[string]any{"taskId": "other-task"}, want: true},
		{name: "empty placeholders", node: map[string]any{"taskId": "", "content": "", "metadata": map[string]any{"url": ""}}, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := NodeHasBindingOccupancy(test.node); got != test.want {
				t.Fatalf("got=%v want=%v", got, test.want)
			}
		})
	}
}

func TestMediaEvidenceDoesNotConfusePromptWithMedia(t *testing.T) {
	for _, test := range []struct {
		metadata map[string]any
		want     bool
	}{
		{map[string]any{"content": "a private prompt"}, false},
		{map[string]any{"content": "https://example.invalid/clip.mp4"}, true},
		{map[string]any{"content": "/api/resources/owned/file"}, true},
		{map[string]any{"storageKey": "resource:owned"}, true},
		{map[string]any{"content": map[string]any{"prompt": "private"}}, false},
	} {
		if got := NodeHasMedia(map[string]any{"metadata": test.metadata}); got != test.want {
			t.Fatalf("got=%v want=%v", got, test.want)
		}
	}
}
