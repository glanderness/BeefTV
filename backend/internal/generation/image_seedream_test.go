package generation

import (
	"context"
	"testing"
)

func TestSeedreamManagedReferencesUseOneJSONGeneration(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "replace object <bbox>10 10 100 100</bbox>", Config: Config{Model: "dola-seedream-5-0-pro-260628", BaseURL: "https://beeftv.app", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1.5K", SeedreamOutputFormat: "png", SeedreamOptimize: "fast"}, ReferenceImages: []Media{{DataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}}}
	result, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input)
	if err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 || port.path != "/v1/images/generations" || port.contentType != "application/json" || result["mode"] != "image" {
		t.Fatalf("wire=%#v result=%#v", port, result)
	}
	if port.body["image"] == nil || port.body["size"] != "1.5K" || port.body["output_format"] != "png" || port.body["watermark"] != false {
		t.Fatalf("body=%#v", port.body)
	}
	if _, exists := port.body["n"]; exists {
		t.Fatal("n must not be sent to Ark")
	}
}

func TestSeedreamGroupAndLayerOptionsStayInOneRequest(t *testing.T) {
	input := Input{Prompt: "three matching views", Config: Config{Model: "seedream-4-5-251128", Size: "4K", SeedreamMaxImages: "3"}}
	body, err := seedreamImageBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["sequential_image_generation"] != "auto" || body["sequential_image_generation_options"].(map[string]any)["max_images"] != 3 {
		t.Fatalf("body=%#v", body)
	}
	input.Config.Model = "dola-seedream-5-0-flash-260915"
	input.Config.Size = "2K"
	input.Config.SeedreamMode = "layers"
	if _, err = seedreamImageBody(input); err == nil {
		t.Fatal("layers require a source image")
	}
	input.ReferenceImages = []Media{{URL: "https://example.test/source.png"}}
	body, err = seedreamImageBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["layer_decomposition"] != true {
		t.Fatalf("body=%#v", body)
	}
	if _, exists := body["sequential_image_generation"]; exists {
		t.Fatal("Flash must not receive group generation")
	}
}

func TestSeedreamCustomGatewayKeepsConfiguredVersion(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "a cup", Config: Config{Model: "seedream-4-0-250828", BaseURL: "http://127.0.0.1:33022/v1", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1600x600"}}
	_, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input)
	if err != nil {
		t.Fatal(err)
	}
	if port.path != "/v1/images/generations" || port.body["size"] != "1600x600" {
		t.Fatalf("wire=%#v", port)
	}
}

func TestSeedreamStreamKeepsDeliveredImagesAfterPartialFailure(t *testing.T) {
	data := []byte("data: {\"type\":\"image_generation.partial_succeeded\",\"image_index\":0,\"url\":\"https://example.test/0.png\",\"size\":\"2048x2048\"}\n\ndata: {\"type\":\"image_generation.partial_failed\",\"image_index\":1,\"error\":{\"message\":\"filtered\"}}\n\n")
	payload, err := readSeedreamImageEvents(data)
	if err != nil || len(payload.Data) != 1 {
		t.Fatalf("payload=%#v err=%v", payload, err)
	}
	if _, err = readSeedreamImageEvents([]byte("data: {\"type\":\"error\",\"error\":{\"message\":\"failed\"}}\n")); err == nil {
		t.Fatal("empty stream must fail")
	}
}

// 火山官方渠道上的国内型号也要走 Seedream 自己的请求体：图层拆分、图片格式、
// 水印和提示词优化都是用户选过的，改走通用插件会静默变成普通生图。
func TestSeedreamDomesticProKeepsConfiguredOptionsOnArkChannel(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "split the layers", Config: Config{
		Model: "doubao-seedream-5-0-pro-260628", BaseURL: "https://beeftv.app", APIKey: "synthetic",
		InterfaceType: "volcengine-ark-image", Size: "16:9", SeedreamMode: "layers",
		SeedreamOutputFormat: "jpeg", SeedreamOptimize: "fast", SeedreamWatermark: "true",
	}, ReferenceImages: []Media{{URL: "https://example.test/source.png"}}}
	if _, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input); err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 {
		t.Fatalf("calls=%d", port.calls)
	}
	if port.body["layer_decomposition"] != true || port.body["output_format"] != "jpeg" || port.body["watermark"] != true {
		t.Fatalf("seedream options lost: body=%#v", port.body)
	}
	if optimize, ok := port.body["optimize_prompt_options"].(map[string]interface{}); !ok || optimize["mode"] != "fast" {
		t.Fatalf("optimize option lost: body=%#v", port.body)
	}
	// 图层拆分只能按档位出图，比例由上游按原图保持。
	if port.body["size"] != "2K" {
		t.Fatalf("size=%#v", port.body["size"])
	}
}

func TestSeedreamDomesticFlashIsNotTreatedAsLite(t *testing.T) {
	// Lite 会拒绝图层拆分与透明背景；国内 Flash 被当成 Lite 时这些能力会被误判。
	input := Input{Prompt: "layers", Config: Config{Model: "doubao-seedream-5-0-flash-260915", Size: "1.5K", SeedreamMode: "layers"}, ReferenceImages: []Media{{URL: "https://example.test/source.png"}}}
	body, err := seedreamImageBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["layer_decomposition"] != true || body["size"] != "1.5K" {
		t.Fatalf("body=%#v", body)
	}
	input.Config.Size = "4K"
	if _, err := seedreamImageBody(input); err == nil {
		t.Fatal("flash must reject the 4K tier")
	}
}

func TestSeedreamRequestBodyFollowsPerModelSizeRules(t *testing.T) {
	for _, item := range []struct {
		model, size, want string
		reject            bool
	}{
		{model: "seedream-4-0-250828", size: "16:9", want: "2560x1440"},
		{model: "seedream-4-0-250828", size: "1600x600", want: "1600x600"},
		{model: "seedream-4-5-251128", size: "5504x3040", want: "5504x3040"},
		{model: "seedream-4-5-251128", size: "1500x1500", reject: true},
		{model: "doubao-seedream-5-0-pro-260628", size: "4K", reject: true},
		{model: "doubao-seedream-5-0-260128", size: "3K", want: "3K"},
	} {
		body, err := seedreamImageBody(Input{Prompt: "x", Config: Config{Model: item.model, Size: item.size}})
		if item.reject {
			if err == nil {
				t.Fatalf("%s %q should be rejected, body=%#v", item.model, item.size, body)
			}
			continue
		}
		if err != nil || body["size"] != item.want {
			t.Fatalf("%s %q -> %#v, %v; want %q", item.model, item.size, body["size"], err, item.want)
		}
	}
}

// 尺寸不合规要在发出付费请求之前就失败，不能等上游 400。
func TestSeedreamRejectsUnsupportedSizeBeforeSending(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "x", Config: Config{Model: "seedream-4-5-251128", BaseURL: "https://beeftv.app", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1K"}}
	if _, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input); err == nil {
		t.Fatal("unsupported size must be rejected")
	}
	if port.calls != 0 {
		t.Fatalf("calls=%d, want 0", port.calls)
	}
}
