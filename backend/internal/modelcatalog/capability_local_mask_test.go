package modelcatalog

import (
	"strings"
	"testing"
)

func TestLocalMaskRequiresExplicitOperationAndSource(t *testing.T) {
	profile := &ImageCapabilityConfig{References: ImageReferenceConfig{MaxImages: 1}, Size: ImageSizeConfig{Parameter: "none"}, MaxOutputs: 1}
	input := TaskInput{ReferenceImages: []MediaRef{{}}, Mask: &MediaRef{}}
	if err := ValidateImageTask(profile, input); err == nil {
		t.Fatal("native mask unexpectedly accepted")
	}
	input.Metadata = map[string]any{"maskEditMode": "local-composite"}
	if err := ValidateImageTask(profile, input); err != nil {
		t.Fatal(err)
	}
	input.ReferenceImages = nil
	if err := ValidateImageTask(profile, input); err == nil {
		t.Fatal("local edit accepted without source")
	}
	input.ReferenceImages = []MediaRef{{}}
	input.Mask = nil
	if err := ValidateImageTask(profile, input); err == nil {
		t.Fatal("local edit accepted without mask")
	}
}

func TestTextOnlyImageModelRejectsRepaintBeforeGeneration(t *testing.T) {
	profile := &ImageCapabilityConfig{References: ImageReferenceConfig{MaxImages: 0}, Size: ImageSizeConfig{Parameter: "none"}, MaxOutputs: 1}
	input := TaskInput{ReferenceImages: []MediaRef{{}}, Mask: &MediaRef{}, Metadata: map[string]any{"maskEditMode": "local-composite"}}
	if err := ValidateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "仅支持文生图") {
		t.Fatalf("text-only repaint: %v", err)
	}
}
