package beefapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// 以下取值来自 2026-10-27 的企业价格目录，用来固定归一规则。
func TestNormalizeCatalogPricingKeepsOnlyBillableFields(t *testing.T) {
	name, pricing, ok := NormalizeCatalogPricing(json.RawMessage(`{
		"model_name": "gpt-image-2", "display_kind": "image", "mode": "per_request", "per_request_cny": 0.35,
		"pricing_note": "按质量和分辨率计费，参考图费用另列。",
		"image_price_table": {"pricebook_id": "enterprise_cny_v1", "currency": "CNY",
			"output": {"high": {"1K": 2.2, "2K": 4.4, "4K": 7.3}, "low": {"1K": 0.35, "2K": 0.7, "4K": 1}},
			"reference": 0.15, "default_quality": "low", "default_size": "1K"}}`))
	if !ok || name != "gpt-image-2" || pricing["kind"] != "image" || pricing["per_request_cny"] != 0.35 {
		t.Fatalf("normalize failed: %q %#v", name, pricing)
	}
	table, _ := pricing["image_price_table"].(map[string]any)
	if table["default_quality"] != "low" || table["reference"] != 0.15 {
		t.Fatalf("image table = %#v", table)
	}
	output, _ := table["output"].(map[string]any)
	low, _ := output["low"].(map[string]any)
	if low["1K"] != 0.35 || low["4K"] != float64(1) {
		t.Fatalf("low tier = %#v", low)
	}
	// 目录内部标识和说明文字不是算价字段，不该存进模型档案。
	for _, leaked := range []string{"pricebook_id", "pricing_note"} {
		if strings.Contains(strings.Join(flattenKeys(pricing), ","), leaked) {
			t.Fatalf("目录内部字段 %s 进入了客户端价格", leaked)
		}
	}

	_, video, ok := NormalizeCatalogPricing(json.RawMessage(`{"model_name":"minimax-h3","display_kind":"video","mode":"per_request",
		"per_second_cny":{"2k":1.322373,"480p":0.508605},"video_input_per_second_cny":{"2k":0,"480p":0},
		"reference_image_cny":0.813768,"free_reference_images":5}`))
	if !ok || video["kind"] != "video" || video["reference_image_cny"] != 0.813768 || video["free_reference_images"] != 5 {
		t.Fatalf("video pricing = %#v", video)
	}
	seconds, _ := video["per_second_cny"].(map[string]any)
	if seconds["2k"] != 1.322373 || seconds["480p"] != 0.508605 {
		t.Fatalf("per second rates = %#v", seconds)
	}

	_, tokens, ok := NormalizeCatalogPricing(json.RawMessage(`{"model_name":"seedance-2.0","display_kind":"video","mode":"video_tokens",
		"video_official":[{"resolution":"720p","input_per_second_cny":0.6048,"output_per_second_cny":0.9936}],
		"video_token_rates":[{"resolution":"720p","input_cny":28,"output_cny":46}]}`))
	if !ok {
		t.Fatal("按 token 计费的视频行被拒绝")
	}
	official, _ := tokens["video_official"].([]any)
	first, _ := official[0].(map[string]any)
	if len(official) != 1 || first["resolution"] != "720p" || first["output_per_second_cny"] != 0.9936 {
		t.Fatalf("official rates = %#v", tokens["video_official"])
	}
	if _, exists := tokens["video_token_rates"]; exists {
		t.Fatal("原始 token 费率无法折算成每次价格，不应存进档案")
	}

	_, speech, ok := NormalizeCatalogPricing(json.RawMessage(`{"model_name":"minimax-speech-2.8-hd","display_kind":"audio","mode":"tokens","input_cny":350,"output_cny":0}`))
	if !ok || speech["input_cny"] != float64(350) || speech["output_cny"] != float64(0) {
		t.Fatalf("speech pricing = %#v", speech)
	}
}

func flattenKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key, raw := range value {
		keys = append(keys, key)
		if nested, ok := raw.(map[string]any); ok {
			keys = append(keys, flattenKeys(nested)...)
		}
	}
	return keys
}

func TestNormalizeCatalogPricingRejectsUnusableRows(t *testing.T) {
	cases := map[string]string{
		"文字模型":   `{"model_name":"deepseek-v4.1-flash","display_kind":"text","mode":"tokens","input_cny":1}`,
		"缺少模型名":  `{"display_kind":"image","per_request_cny":1}`,
		"没有计费字段": `{"model_name":"mystery","display_kind":"image"}`,
		"价格非数字":  `{"model_name":"mystery","display_kind":"image","per_request_cny":"free"}`,
		"空行":     ``,
	}
	for name, raw := range cases {
		if _, _, ok := NormalizeCatalogPricing(json.RawMessage(raw)); ok {
			t.Fatalf("%s 不应被当作可用价格", name)
		}
	}
	if prices := ParseEnterpriseCatalog([]byte(`{"data":{"currency":"USD","models":[{"model_name":"gpt-image-2","display_kind":"image","per_request_cny":1}]}}`)); prices != nil {
		t.Fatalf("非人民币目录不应被接受: %#v", prices)
	}
	if prices := ParseEnterpriseCatalog([]byte(`not json`)); prices != nil {
		t.Fatalf("不可读目录应返回 nil: %#v", prices)
	}
	if prices := ParseEnterpriseCatalog([]byte(`{"data":{"currency":"CNY","models":[{"model_name":"gpt-image-2","display_kind":"image","per_request_cny":0.35},{"model_name":"junk"}]}}`)); len(prices) != 1 || prices["gpt-image-2"] == nil {
		t.Fatalf("单行读不懂不应影响其他模型: %#v", prices)
	}
}

func TestRefreshCatalogStoresEnterprisePricing(t *testing.T) {
	svc, store, _ := testService(t, &fakeEnterprise{})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channel := findChannel(current.Config["channels"].([]any), ChannelID)
	image := refreshTestProfile(channel, "gpt-image-2")
	pricing, _ := image["pricing"].(map[string]any)
	if pricing == nil || pricing["kind"] != "image" || pricing["per_request_cny"] != 0.35 {
		t.Fatalf("图片目录单价未保存: %#v", image)
	}
	video := refreshTestProfile(channel, "seedance-test")
	videoPricing, _ := video["pricing"].(map[string]any)
	if videoPricing == nil || videoPricing["kind"] != "video" {
		t.Fatalf("视频目录单价未保存: %#v", video)
	}
	// 目录里没有这一行就保持没有价格，不能按名字猜一个。
	if refreshTestProfile(channel, "gpt-test")["pricing"] != nil {
		t.Fatal("目录没有的模型不应写入价格")
	}
	// 文字模型的价格不是画布计费项，不进档案。
	if entry := refreshTestProfile(channel, "text-only-model"); entry != nil {
		t.Fatal("文字模型不在模型列表里，不该出现档案")
	}
}

func TestRefreshCatalogKeepsModelsWhenPricingUnavailable(t *testing.T) {
	svc, store, _ := testService(t, &fakeEnterprise{pricingFail: true})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	models, err := svc.RefreshCatalog(context.Background())
	if err != nil || len(models) != 3 {
		t.Fatalf("价格目录读失败不应影响模型列表: %v %d", err, len(models))
	}
	current, _, _ := store.LoadEffectiveModelConfig()
	channel := findChannel(current.Config["channels"].([]any), ChannelID)
	if refreshTestProfile(channel, "gpt-image-2")["pricing"] != nil {
		t.Fatal("价格目录读失败时不应写入价格")
	}
}

func TestRefreshCatalogClearsPricingWhenCatalogStopsQuoting(t *testing.T) {
	fake := &fakeEnterprise{pricing: []map[string]any{
		{"model_name": "gpt-image-2", "display_kind": "image", "mode": "per_request", "per_request_cny": 0.35},
	}}
	svc, store, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	read := func() map[string]any {
		current, _, err := store.LoadEffectiveModelConfig()
		if err != nil {
			t.Fatal(err)
		}
		return refreshTestProfile(findChannel(current.Config["channels"].([]any), ChannelID), "gpt-image-2")
	}
	if read()["pricing"] == nil {
		t.Fatal("价格目录里的单价未写入档案")
	}
	// 模型仍在，但目录不再给这一行价格：旧价必须清空，界面显示「暂无价格」。
	fake.mu.Lock()
	fake.pricing = []map[string]any{}
	fake.mu.Unlock()
	if _, err := svc.RefreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	profile := read()
	if profile == nil || profile["pricing"] != nil {
		t.Fatalf("目录不再提供价格时应清空旧价: %#v", profile)
	}
}
