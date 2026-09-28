package app

import "testing"

func TestSeedance25EnterpriseFirstFrameIsExplicit(t *testing.T) {
	for _, name := range []string{"seedance-2.5", "seedance-2.5-official"} {
		input := canvasGenerationInput{Mode: "video", Config: providerConfig{Model: name, Size: "9:16", VideoSeconds: "6", VQuality: "720p"}, ReferenceImages: []providerMedia{{ID: "first", DataURL: testReferenceImageDataURL}}}
		body, err := beefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		content := body["content"].([]map[string]interface{})
		if content[0]["role"] != "first_frame" || body["metadata"].(map[string]interface{})["ratio"] != "adaptive" || body["seconds"] != "6" {
			t.Fatalf("incorrect frame options: %#v", body)
		}
		request := protocolRequestFromInput(input)
		if request.Images[0].Role != "first_frame" || request.AspectRatio != "adaptive" {
			t.Fatalf("native request differs: %#v", request)
		}
		input.Metadata = map[string]interface{}{"videoEditOperation": "reference_to_video"}
		body, err = beefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		if body["content"].([]map[string]interface{})[0]["role"] != "reference_image" || body["metadata"].(map[string]interface{})["ratio"] != "9:16" {
			t.Fatalf("reference intent changed: %#v", body)
		}
	}
}

func TestSeedance20EnterpriseReferencesUnchanged(t *testing.T) {
	input := canvasGenerationInput{Config: providerConfig{Model: "seedance-2.0", Size: "9:16", VideoSeconds: "6"}, ReferenceImages: []providerMedia{{ID: "a", URL: "https://example.com/a.png"}, {ID: "b", URL: "https://example.com/b.png"}}}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range body["content"].([]map[string]interface{}) {
		if item["role"] != "reference_image" {
			t.Fatal("2.0 reference intent changed")
		}
	}
}
