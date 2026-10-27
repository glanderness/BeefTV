package modelcatalog

import (
	"encoding/json"
	"strconv"
	"testing"
)

// 以下 pricing 取自 2026-10-27 的企业价格目录（经 beefapi 归一后的形状），
// 用来固定算价规则本身；目录改价不会让这些用例失效。
func pricing(t *testing.T, raw string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("pricing fixture is invalid: %v", err)
	}
	return value
}

func TestEstimateImageCostFromPriceTable(t *testing.T) {
	gptImage := pricing(t, `{"currency":"CNY","kind":"image","mode":"per_request","per_request_cny":0.35,
		"image_price_table":{"output":{"low":{"1K":0.35,"2K":0.7,"4K":1},"medium":{"1K":0.6,"2K":1.1,"4K":1.9},"high":{"1K":2.2,"2K":4.4,"4K":7.3}},
		"reference":0.15,"default_quality":"low","default_size":"1K"}}`)

	line := EstimateCost(CostRequest{Kind: "image", Model: "gpt-image-2", Pricing: gptImage,
		Parameters: map[string]string{"quality": "low", "size": "1024x1024", "count": "2"}, ReferenceCount: 1})
	if line.Amount == nil || *line.Amount != 0.85 {
		t.Fatalf("amount = %v, want 0.85", line.Amount)
	}
	if line.Basis != "1K 低质量 ¥0.35 × 2 张 + 参考图 ¥0.15 × 1 张" {
		t.Fatalf("basis = %q", line.Basis)
	}

	// 质量档用节点参数，尺寸档按长边归档：2048x2048 落到 2K。
	high := EstimateCost(CostRequest{Kind: "image", Model: "gpt-image-2", Pricing: gptImage,
		Parameters: map[string]string{"quality": "high", "size": "2048x2048"}})
	if high.Amount == nil || *high.Amount != 4.4 {
		t.Fatalf("high quality amount = %v, want 4.4", high.Amount)
	}
	if high.Basis != "2K 高质量 ¥4.4 × 1 张" {
		t.Fatalf("high basis = %q", high.Basis)
	}

	// auto 质量回落到目录默认档，比例尺寸用价表默认分辨率。
	auto := EstimateCost(CostRequest{Kind: "image", Model: "gpt-image-2", Pricing: gptImage,
		Parameters: map[string]string{"quality": "auto", "size": "1:1"}})
	if auto.Amount == nil || *auto.Amount != 0.35 {
		t.Fatalf("auto amount = %v, want 0.35", auto.Amount)
	}
	if auto.Basis != "1K 低质量 ¥0.35 × 1 张" {
		t.Fatalf("auto basis = %q", auto.Basis)
	}
}

func TestEstimateImageCostFallsBackToBasePrice(t *testing.T) {
	hyImage := pricing(t, `{"currency":"CNY","kind":"image","mode":"per_request","per_request_cny":0.2}`)
	line := EstimateCost(CostRequest{Kind: "image", Model: "hy-image-v3", Pricing: hyImage,
		Parameters: map[string]string{"count": "3"}})
	if line.Amount == nil || *line.Amount != 0.6 {
		t.Fatalf("amount = %v, want 0.6", line.Amount)
	}
	if line.Basis != "按基础价 ¥0.2 × 3 张" {
		t.Fatalf("basis = %q", line.Basis)
	}
}

func TestEstimateVideoCostPerSecondWithFreeReferenceImages(t *testing.T) {
	h3 := pricing(t, `{"currency":"CNY","kind":"video","mode":"per_request",
		"per_second_cny":{"2k":1.322373,"480p":0.508605,"4k":1.627536,"768p":0.610326},
		"video_input_per_second_cny":{"2k":0,"480p":0,"4k":0,"768p":0},
		"reference_image_cny":0.813768,"free_reference_images":5}`)

	line := EstimateCost(CostRequest{Kind: "video", Model: "minimax-h3", Pricing: h3,
		Parameters: map[string]string{"vquality": "768p", "seconds": "6"}, ReferenceCount: 2})
	if line.Amount == nil || *line.Amount != 3.662 {
		t.Fatalf("amount = %v, want 3.662", line.Amount)
	}
	if line.Basis != "768p ¥0.6103/秒 × 6秒" {
		t.Fatalf("basis = %q", line.Basis)
	}

	// 超过免费张数的参考图按张另计。
	paid := EstimateCost(CostRequest{Kind: "video", Model: "minimax-h3", Pricing: h3,
		Parameters: map[string]string{"vquality": "768p", "seconds": "6"}, ReferenceCount: 7})
	if paid.Amount == nil || *paid.Amount != 5.2895 {
		t.Fatalf("paid amount = %v, want 5.2895", paid.Amount)
	}
	if paid.Basis != "768p ¥0.6103/秒 × 6秒 + 参考图 ¥0.8138 × 2 张" {
		t.Fatalf("paid basis = %q", paid.Basis)
	}

	// 2160p 对到目录的 4k 档。
	fourK := EstimateCost(CostRequest{Kind: "video", Model: "minimax-h3", Pricing: h3,
		Parameters: map[string]string{"vquality": "2160p", "seconds": "5"}})
	if fourK.Amount == nil || *fourK.Amount != 8.1377 {
		t.Fatalf("4k amount = %v, want 8.1377", fourK.Amount)
	}
}

func TestEstimateVideoCostTokenModelUsesOfficialPerSecond(t *testing.T) {
	seedance := pricing(t, `{"currency":"CNY","kind":"video","mode":"video_tokens",
		"video_official":[{"resolution":"720p","input_per_second_cny":0.6048,"output_per_second_cny":0.9936},
		{"resolution":"480p","input_per_second_cny":0.281232,"output_per_second_cny":0.462024}]}`)
	line := EstimateCost(CostRequest{Kind: "video", Model: "seedance-2.0", Pricing: seedance,
		Parameters: map[string]string{"vquality": "720p", "seconds": "5"}})
	if line.Amount == nil || *line.Amount != 4.968 {
		t.Fatalf("amount = %v, want 4.968", line.Amount)
	}
	if line.Basis != "720p 约 ¥0.9936/秒 × 5秒（按 Token 折算）" {
		t.Fatalf("basis = %q", line.Basis)
	}
}

func TestEstimateCostReportsUnknownInsteadOfZero(t *testing.T) {
	portrait := pricing(t, `{"currency":"CNY","kind":"video","mode":"video_tokens",
		"video_token_rates":[{"resolution":"720p","input_cny":54.115572,"output_cny":88.022572}]}`)
	token := EstimateCost(CostRequest{Kind: "video", Model: "seedance-2.5-portrait", Pricing: portrait,
		Parameters: map[string]string{"vquality": "720p", "seconds": "5"}})
	if token.Amount != nil || token.Basis != "按视频 Token 计费，暂无法折算成每次价格" {
		t.Fatalf("token line = %+v", token)
	}

	topaz := pricing(t, `{"currency":"CNY","kind":"image","mode":"per_request","per_request_cny":27.1256}`)
	upscale := EstimateCost(CostRequest{Kind: "image", Model: "beefapi::topaz-standard-v2", Pricing: topaz})
	if upscale.Amount != nil || upscale.Basis != "超分按先扣金额结算，不计入合计" {
		t.Fatalf("upscale line = %+v", upscale)
	}

	unknown := EstimateCost(CostRequest{Kind: "image", Model: "custom-image", Pricing: nil})
	if unknown.Amount != nil || unknown.Basis != "暂无价格" {
		t.Fatalf("unknown line = %+v", unknown)
	}

	missingSeconds := EstimateCost(CostRequest{Kind: "video", Model: "minimax-h3-max", Pricing: pricing(t, `{"currency":"CNY","kind":"video","per_second_cny":{"1080p":0.9765216}}`),
		Parameters: map[string]string{"vquality": "1080p"}})
	if missingSeconds.Amount != nil || missingSeconds.Basis != "1080p ¥0.9765/秒，缺少时长" {
		t.Fatalf("missing seconds line = %+v", missingSeconds)
	}
}

func TestEstimateAudioCost(t *testing.T) {
	speech := pricing(t, `{"currency":"CNY","kind":"audio","mode":"tokens","input_cny":350,"output_cny":0}`)
	line := EstimateCost(CostRequest{Kind: "audio", Model: "minimax-speech-2.8-hd", Pricing: speech, Text: "这是一段需要配音的台词文本，用来验证按字数估算。"})
	characters := len([]rune("这是一段需要配音的台词文本，用来验证按字数估算。"))
	if line.Amount == nil || *line.Amount != roundMoney(350.0/1_000_000*float64(characters)) {
		t.Fatalf("speech amount = %v, want %v", line.Amount, roundMoney(350.0/1_000_000*float64(characters)))
	}
	if line.Basis != "约 ¥350/百万字 × "+strconv.Itoa(characters)+" 字" {
		t.Fatalf("speech basis = %q", line.Basis)
	}

	missingText := EstimateCost(CostRequest{Kind: "audio", Model: "minimax-speech-2.8-hd", Pricing: speech})
	if missingText.Amount != nil || missingText.Basis != "缺少台词文本" {
		t.Fatalf("missing text line = %+v", missingText)
	}

	music := pricing(t, `{"currency":"CNY","kind":"audio","mode":"per_request","per_request_cny":1}`)
	times := EstimateCost(CostRequest{Kind: "audio", Model: "minimax-music-v3.0", Pricing: music, Parameters: map[string]string{"count": "2"}})
	if times.Amount == nil || *times.Amount != 2 || times.Basis != "¥1/次 × 2 次" {
		t.Fatalf("music line = %+v", times)
	}
}

func TestSumCostLinesKeepsUnknownOutOfTotal(t *testing.T) {
	summary := SumCostLines([]CostLine{
		{Kind: "image", Amount: money(0.35), Basis: "1K 低质量 ¥0.35 × 1 张"},
		{Kind: "video", Amount: money(4.968), Basis: "720p 约 ¥0.9936/秒 × 5秒（按 Token 折算）"},
		{Kind: "audio", Basis: "缺少台词文本"},
	})
	if summary.Total != 5.318 || summary.Known || summary.UnknownCount != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.Text != "预计费用 ¥5.318（已知部分），另有 1 项暂无价格" {
		t.Fatalf("text = %q", summary.Text)
	}

	allKnown := SumCostLines([]CostLine{{Kind: "image", Amount: money(0.35)}, {Kind: "image", Amount: money(0.15)}})
	if !allKnown.Known || allKnown.Text != "预计费用 ¥0.5" {
		t.Fatalf("allKnown = %+v", allKnown)
	}

	none := SumCostLines([]CostLine{{Kind: "image", Basis: "暂无价格"}})
	if none.Text != "暂无可用价格，按所选渠道实际标准计费" || none.Total != 0 {
		t.Fatalf("none = %+v", none)
	}

	empty := SumCostLines(nil)
	if empty.Text != "画布上还没有可估算费用的生成节点" || empty.Known {
		t.Fatalf("empty = %+v", empty)
	}
}
