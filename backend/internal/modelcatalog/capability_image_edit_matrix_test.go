package modelcatalog

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

// Optional live catalogue input contains only public model IDs/capabilities,
// never endpoints or credentials. Validation must not submit a paid request.
func TestImageEditLiveCatalogContracts(t *testing.T) {
	raw := os.Getenv("BEEFTV_IMAGE_EDIT_CATALOG")
	if raw == "" {
		t.Skip("live image catalogue not supplied")
	}
	var entries []struct {
		ID    string                `json:"id"`
		Image ImageCapabilityConfig `json:"image"`
	}
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("empty catalogue")
	}
	for _, entry := range entries {
		t.Run(entry.ID, func(t *testing.T) {
			profile := entry.Image
			version := "live-catalogue"
			count := 1
			if profile.FixedOutputs > 0 {
				count = profile.FixedOutputs
			}
			input := TaskInput{Config: TaskConfig{Model: entry.ID, ImageCapabilitiesVersion: &version, Size: profile.Size.Default, Quality: profile.Quality.Default, Count: strconv.Itoa(count)}, ReferenceImages: []MediaRef{{}}, Mask: &MediaRef{}}
			if !profile.References.MaskSupported {
				input.Metadata = map[string]any{"maskEditMode": "local-composite"}
			}
			err := ValidateImageTask(&profile, input)
			if profile.References.MaxImages == 0 {
				if err == nil {
					t.Fatal("text-only model accepted an edit")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
