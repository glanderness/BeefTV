package providerpreset

import (
	"strings"
	"testing"
)

func TestMidjourneyPromptControls(t *testing.T) {
	c, ok := BeefTVImageContract("midjourney-v8.2")
	if !ok {
		t.Fatal("missing contract")
	}
	if len(c.Presets) != 16 {
		t.Fatalf("expected 16 presets (1K + 2K), got %d", len(c.Presets))
	}
	for _, preset := range c.Presets {
		got, err := c.GenerationPrompt("a red cube", preset.Size)
		expected := "a red cube"
		if preset.Ratio != "1:1" {
			expected += " --ar " + preset.Ratio
		}
		if preset.Tier == "2k" {
			expected += " --hd"
		}
		if err != nil || got != expected {
			t.Fatalf("%s: got %q err=%v, want %q", preset.Size, got, err, expected)
		}
	}
	got, err := c.GenerationPrompt("a cube --ar 16:9", "1456x816")
	if err != nil || strings.Count(got, "--ar") != 1 {
		t.Fatalf("duplicate flags: %q %v", got, err)
	}
	// Prompt --ar, --hd, --q, --raw, --s, --p override UI defaults cleanly.
	gotOverride, err := c.GenerationPrompt("a cube --ar 16:9 --hd --q 2 --raw --s 500 --p m1234", "1024x1024")
	if err != nil || gotOverride != "a cube --ar 16:9 --hd --q 2 --raw --s 500 --p m1234" {
		t.Fatalf("prompt override failed: %q %v", gotOverride, err)
	}
	for _, prompt := range []string{"a cube --v 7", "a cube --repeat 4", "a cube --fast", "a cube --hd=1", "--ar 16:9"} {
		if _, err := c.GenerationPrompt(prompt, "1456x816"); err == nil {
			t.Fatalf("accepted invalid prompt %q", prompt)
		}
	}
	if _, err := c.GenerationPrompt(strings.Repeat("x", 12000), "1456x816"); err != nil {
		t.Fatalf("long prompt should be delegated to upstream, got %v", err)
	}
	if _, err := c.GenerationPrompt("a cube", "1824x1024"); err == nil {
		t.Fatal("unsupported size accepted")
	}
}
