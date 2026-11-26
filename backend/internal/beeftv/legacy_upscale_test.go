package beeftv

import "testing"

func TestLegacyUpscaleBodyEstimateMetadataContract(t *testing.T) {
	// Image metadata-only estimate: carries width/height without image_url.
	imgBody := LegacyUpscaleBody(LegacyUpscaleInput{
		Model:        "topaz-standard-v2",
		MediaType:    "image",
		Factor:       2,
		OutputFormat: "png",
		Width:        1920,
		Height:       1080,
		EstimateOnly: true,
	})
	if _, hasURL := imgBody["image_url"]; hasURL {
		t.Fatalf("metadata-only image estimate must not emit image_url: %#v", imgBody)
	}
	if imgBody["width"] != 1920 || imgBody["height"] != 1080 || imgBody["upscale_factor"] != float64(2) || imgBody["output_format"] != "png" {
		t.Fatalf("unexpected image estimate body: %#v", imgBody)
	}

	// Video metadata-only estimate: carries width/height/duration_seconds/frame_rate without video_url.
	vidBody := LegacyUpscaleBody(LegacyUpscaleInput{
		Model:           "topaz-starlight-fast-2",
		MediaType:       "video",
		Factor:          2.125,
		Width:           1920,
		Height:          1080,
		DurationSeconds: 12.5,
		FrameRate:       24,
		EstimateOnly:    true,
	})
	if _, hasURL := vidBody["video_url"]; hasURL {
		t.Fatalf("metadata-only video estimate must not emit video_url: %#v", vidBody)
	}
	if vidBody["width"] != 1920 || vidBody["height"] != 1080 || vidBody["upscale_factor"] != 2.125 || vidBody["duration_seconds"] != 12.5 || vidBody["frame_rate"] != float64(24) {
		t.Fatalf("unexpected video estimate body: %#v", vidBody)
	}

	// Real /tasks submission keeps source URL and never emits estimate-only metadata fields.
	submitBody := LegacyUpscaleBody(LegacyUpscaleInput{
		Model:        "topaz-standard-v2",
		MediaType:    "image",
		SourceURL:    "https://storage.example/input.png",
		Factor:       2,
		Width:        1920,
		Height:       1080,
		EstimateOnly: false,
	})
	if submitBody["image_url"] != "https://storage.example/input.png" {
		t.Fatalf("submit body lost image_url: %#v", submitBody)
	}
	if _, hasWidth := submitBody["width"]; hasWidth {
		t.Fatalf("submit body must not emit estimate-only width: %#v", submitBody)
	}
}
