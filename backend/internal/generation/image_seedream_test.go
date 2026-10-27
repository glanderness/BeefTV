package generation

import (
	"context"
	"os"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

const seedreamTestPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="

// 官方 Ark 渠道即使安装了 Seedream 声明式插件，也必须走保留图层拆分、格式、水印和优化模式的
// Seedream 请求体；改走插件会把用户确认过的设置静默丢掉。
func TestSeedreamArkChannelKeepsLayersFormatAndWatermark(t *testing.T) {
	raw, err := os.ReadFile("../../../plugin-packages/volcengine-ark-seedream/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "拆出主体", Config: Config{
		Model:                "doubao-seedream-5-0-pro-260628",
		BaseURL:              "https://ark.cn-beijing.volces.com",
		APIKey:               "synthetic",
		InterfaceType:        "volcengine-ark-image",
		Size:                 "16:9",
		SeedreamMode:         "layers",
		SeedreamOutputFormat: "jpeg",
		SeedreamOptimize:     "fast",
		SeedreamWatermark:    "true",
	}, ReferenceImages: []Media{{DataURL: seedreamTestPNG}}}
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), Runtime{Images: port}), registry)
	if _, err := RunImageTask(ctx, input); err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 || port.path != "/api/v3/images/generations" || port.contentType != "application/json" {
		t.Fatalf("wire=%#v", port)
	}
	// 图层拆分只接受档位，比例回到默认档位。
	if port.body["layer_decomposition"] != true || port.body["output_format"] != "jpeg" || port.body["watermark"] != true || port.body["size"] != "2K" {
		t.Fatalf("body=%#v", port.body)
	}
	options, ok := port.body["optimize_prompt_options"].(map[string]any)
	if !ok || options["mode"] != "fast" {
		t.Fatalf("body=%#v", port.body)
	}
}

// Agent Plan 图片协议是独立端点，Seedream 型号必须继续交给它的声明式插件。
func TestSeedreamAgentPlanChannelKeepsItsOwnEndpoint(t *testing.T) {
	raw, err := os.ReadFile("../../../plugin-packages/volcengine-ark-agent-plan-seedream/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "一只猫", Config: Config{
		Model:         "doubao-seedream-5-0-260128",
		BaseURL:       "https://ark.cn-beijing.volces.com",
		APIKey:        "synthetic",
		InterfaceType: "volcengine-ark-agent-plan-image",
		Size:          "16:9",
	}}
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), Runtime{Images: port}), registry)
	if _, err := RunImageTask(ctx, input); err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 || port.path != "/api/plan/v3/images/generations" || port.body["size"] != "2560x1440" {
		t.Fatalf("wire=%#v", port)
	}
}

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

func TestSeedreamMapsCanvasAspectRatiosToSupportedDimensions(t *testing.T) {
	body, err := seedreamImageBody(Input{Prompt: "ink painting", Config: Config{Model: "dola-seedream-5-0-pro-260628", Size: "16:9"}})
	if err != nil {
		t.Fatal(err)
	}
	if body["size"] != "2560x1440" {
		t.Fatalf("expected 16:9 to map to 2560x1440, got %#v", body["size"])
	}
	layerBody, err := seedreamImageBody(Input{
		Prompt:          "layers",
		Config:          Config{Model: "doubao-seedream-5-0-pro-260628", Size: "16:9", SeedreamMode: "layers"},
		ReferenceImages: []Media{{URL: "https://example.test/source.png"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if layerBody["size"] != "2K" {
		t.Fatalf("expected layers mode to map aspect ratio to 2K, got %#v", layerBody["size"])
	}
}

// 预检与实际请求共用同一份尺寸规则，这里覆盖同一批反例在请求路径上的行为。
func TestSeedreamRequestRejectsSizesOutsideModelLimits(t *testing.T) {
	for _, test := range []struct{ model, size string }{
		{"doubao-seedream-5-0-pro-260628", "4K"},
		{"doubao-seedream-4-5-251128", "1500x1500"},
		{"doubao-seedream-4-5-251128", "1K"},
		{"seedream-5-0-260128", "512x512"},
	} {
		if _, err := seedreamImageBody(Input{Prompt: "a cup", Config: Config{Model: test.model, Size: test.size}}); err == nil {
			t.Fatalf("%s size=%s must be rejected", test.model, test.size)
		}
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
