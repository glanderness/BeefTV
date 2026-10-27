package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/modelcatalog"
)

// costProbe 实现费用估算需要的两个窄端口：画布读取、模型解析与目录单价。
type costProbe struct {
	unusedDomain
	doc     json.RawMessage
	pricing map[string]map[string]any
}

func (p *costProbe) UserCanvasProject(string, string) (json.RawMessage, error) {
	return p.doc, nil
}

func (p *costProbe) ResolveAssistantGenerationModel(kind, selected string) (AssistantGenerationModel, error) {
	if selected == "" {
		selected = "beefapi::gpt-image-2"
	}
	return AssistantGenerationModel{Display: selected, ModelKey: selected, Revision: 1}, nil
}

func (p *costProbe) ModelCostPricing(modelKey string) (map[string]any, bool) {
	pricing, ok := p.pricing[modelKey]
	return pricing, ok
}

func costCanvas(nodes ...map[string]any) json.RawMessage {
	raw, err := json.Marshal(map[string]any{"id": "c1", "revision": 7, "nodes": nodes, "connections": []any{}})
	if err != nil {
		panic(err)
	}
	return raw
}

func costCanvasWith(nodes []map[string]any, connections [][2]string) json.RawMessage {
	edges := make([]any, 0, len(connections))
	for _, connection := range connections {
		edges = append(edges, map[string]any{"id": connection[0] + "->" + connection[1], "fromNodeId": connection[0], "toNodeId": connection[1]})
	}
	raw, err := json.Marshal(map[string]any{"id": "c1", "revision": 7, "nodes": nodes, "connections": edges})
	if err != nil {
		panic(err)
	}
	return raw
}

func costNode(id, kind, model string, metadata map[string]any) map[string]any {
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["model"] = model
	return map[string]any{"id": id, "type": kind, "title": id, "metadata": metadata}
}

func imagePricingTable() map[string]any {
	return map[string]any{
		"currency": "CNY", "kind": "image", "mode": "per_request", "per_request_cny": 0.35,
		"image_price_table": map[string]any{
			"output":          map[string]any{"low": map[string]any{"1K": 0.35, "2K": 0.7, "4K": 1.0}},
			"reference":       0.15,
			"default_quality": "low",
			"default_size":    "1K",
		},
	}
}

func TestOpCanvasCostEstimateSumsSelectedTargets(t *testing.T) {
	probe := &costProbe{
		doc: costCanvas(
			costNode("n1", "image", "beefapi::gpt-image-2", map[string]any{"size": "2K", "quality": "low", "prompt": "封面"}),
			costNode("n2", "video", "beefapi::minimax-h3", map[string]any{"seconds": 5, "vquality": "2k"}),
		),
		pricing: map[string]map[string]any{
			"beefapi::gpt-image-2": imagePricingTable(),
			"beefapi::minimax-h3":  {"currency": "CNY", "kind": "video", "mode": "per_request", "per_second_cny": map[string]any{"2k": 1.322373}},
		},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["revision"] != float64(7) {
		t.Fatalf("estimate must bind the canvas revision: %#v", payload)
	}
	summary, ok := payload["estimate"].(*modelcatalog.CostSummary)
	if !ok || summary == nil {
		t.Fatalf("estimate missing: %#v", payload)
	}
	if !summary.Known || summary.UnknownCount != 0 || len(summary.Items) != 2 {
		t.Fatalf("summary = %#v", summary)
	}
	if summary.Total != 7.3119 || summary.Text != "预计费用 ¥7.3119" {
		t.Fatalf("total = %v text = %q", summary.Total, summary.Text)
	}
	if summary.Items[0].NodeID != "n1" || summary.Items[0].Model != "gpt-image-2" || summary.Items[0].Basis != "2K 低质量 ¥0.7 × 1 张" {
		t.Fatalf("image line = %#v", summary.Items[0])
	}
	if summary.Items[1].Kind != "video" || summary.Items[1].Basis != "2k ¥1.3224/秒 × 5秒" {
		t.Fatalf("video line = %#v", summary.Items[1])
	}
	// 价格只在估算结果里出现，不写回画布。
	if strings.Contains(string(probe.doc), "per_second_cny") {
		t.Fatal("estimate mutated the canvas document")
	}
}

func TestOpCanvasCostEstimateNamesUnknownPricesInsteadOfZero(t *testing.T) {
	probe := &costProbe{
		doc: costCanvas(
			costNode("n1", "image", "beefapi::gpt-image-2", map[string]any{"size": "2K"}),
			costNode("n2", "image", "beefapi::mystery-image", nil),
			costNode("n3", "image", "beefapi::topaz-upscale", nil),
		),
		pricing: map[string]map[string]any{
			"beefapi::gpt-image-2":   imagePricingTable(),
			"beefapi::topaz-upscale": {"currency": "CNY", "kind": "image", "per_request_cny": 5},
			"beefapi::unused-image":  {"currency": "CNY", "kind": "image", "per_request_cny": 9},
		},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if summary.Total != 0.7 || summary.Known || summary.UnknownCount != 2 {
		t.Fatalf("算不出的项不能当 0 元，也不能算进合计: %#v", summary)
	}
	if summary.Text != "预计费用 ¥0.7（已知部分），另有 2 项暂无价格" {
		t.Fatalf("text = %q", summary.Text)
	}
	if summary.Items[1].Amount != nil || summary.Items[1].Basis != "暂无价格" {
		t.Fatalf("没有目录行时显示暂无价格: %#v", summary.Items[1])
	}
	if summary.Items[2].Amount != nil || summary.Items[2].Basis != "超分按先扣金额结算，不计入合计" {
		t.Fatalf("超分只显示先扣金额、不进合计: %#v", summary.Items[2])
	}
}

func TestOpCanvasCostEstimateWithoutAnyPriceSaysSo(t *testing.T) {
	probe := &costProbe{doc: costCanvas(costNode("n1", "image", "beefapi::mystery-image", nil))}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if summary.Known || summary.UnknownCount != 1 || summary.Text != "暂无可用价格，按所选渠道实际标准计费" {
		t.Fatalf("summary = %#v", summary)
	}
}

func TestOpCanvasCostEstimateScanSkipsFinishedNodesAndEmptyCanvas(t *testing.T) {
	probe := &costProbe{
		doc: costCanvas(
			costNode("n1", "image", "beefapi::gpt-image-2", map[string]any{"content": "https://example.test/done.png"}),
			costNode("n2", "image", "", map[string]any{"size": "1K"}),
		),
		pricing: map[string]map[string]any{"beefapi::gpt-image-2": imagePricingTable()},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 1 || summary.Items[0].NodeID != "n2" {
		t.Fatalf("已经有成品的节点不该重复估算: %#v", summary.Items)
	}
	// 显式点名节点时按调用方的选择估算，不因为已有成品就跳过。
	result, err = opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"]}`))
	if err != nil {
		t.Fatal(err)
	}
	summary = result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 1 || summary.Items[0].NodeID != "n1" || summary.Total != 0.35 {
		t.Fatalf("点名节点应照算: %#v", summary)
	}

	empty := &costProbe{doc: costCanvas(), pricing: map[string]map[string]any{"beefapi::gpt-image-2": imagePricingTable()}}
	result, err = opCanvasCostEstimate(&Context{UserID: "owner", Domain: empty}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary = result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 0 || summary.Known || summary.Text != "画布上还没有可估算费用的生成节点" {
		t.Fatalf("空画布 summary = %#v", summary)
	}
}

func TestOpCanvasCostEstimateBatchCountsOneOffTargets(t *testing.T) {
	probe := &costProbe{
		doc:     costCanvas(),
		pricing: map[string]map[string]any{"beefapi::gpt-image-2": imagePricingTable()},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","batch":{"kind":"image","model":"beefapi::gpt-image-2","count":3}}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 1 || summary.Total != 1.05 || summary.Items[0].Basis != "1K 低质量 ¥0.35 × 3 张" {
		t.Fatalf("batch summary = %#v", summary)
	}

	// 分镜批量带着逐条参数时按条算，条数就是合计的乘数。
	result, err = opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","batch":{"kind":"image","model":"beefapi::gpt-image-2","items":[{"parameters":{"size":"2K","quality":"low"}},{"parameters":{"size":"1K","quality":"low"}}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	summary = result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 2 || summary.Total != 1.05 {
		t.Fatalf("batch items summary = %#v", summary)
	}
}

func TestOpCanvasCostEstimateBatchCountsReferencesPerItem(t *testing.T) {
	// 换装一行两张参考图、另一行一张：参考图费用要按每行实际张数算，不能只看行数。
	probe := &costProbe{
		doc: costCanvas(
			costNode("r1", "image", "", map[string]any{"content": "a.png"}),
			costNode("r2", "image", "", map[string]any{"content": "b.png"}),
		),
		pricing: map[string]map[string]any{"beefapi::gpt-image-2": imagePricingTable()},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","batch":{"kind":"image","model":"beefapi::gpt-image-2","items":[
		{"parameters":{"size":"1K","quality":"low"},"referenceNodeIds":["r1","r2"]},
		{"parameters":{"size":"1K","quality":"low"},"referenceNodeIds":["r1"]}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 2 || summary.Total != 1.15 {
		t.Fatalf("batch summary = %#v", summary)
	}
	if summary.Items[0].Basis != "1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张" {
		t.Fatalf("两张参考图的行 = %#v", summary.Items[0])
	}
	if summary.Items[1].Basis != "1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 1 张" {
		t.Fatalf("一张参考图的行 = %#v", summary.Items[1])
	}
}

func TestOpCanvasCostEstimateCountsReferenceVideoSeconds(t *testing.T) {
	wan := map[string]any{
		"currency": "CNY", "kind": "video", "mode": "per_request",
		"per_second_cny": map[string]any{"720p": 0.81}, "reference_video_billed_as_output": true,
	}
	probe := &costProbe{
		doc: costCanvasWith([]map[string]any{
			costNode("ref", "video", "", map[string]any{"content": "https://example.test/ref.mp4", "durationMs": 10000}),
			costNode("n1", "video", "beefapi::wan3.0-video", map[string]any{"vquality": "720", "seconds": 5}),
		}, [][2]string{{"ref", "n1"}}),
		pricing: map[string]map[string]any{"beefapi::wan3.0-video": wan},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if len(summary.Items) != 1 || summary.Total != 12.15 || !summary.Known {
		t.Fatalf("带参考视频的估算 = %#v", summary)
	}
	if summary.Items[0].Basis != "720p ¥0.81/秒 × 15秒（输出 5 秒 + 参考视频 10 秒）" {
		t.Fatalf("参考视频秒数要计入 = %#v", summary.Items[0])
	}

	// 参考视频没有时长记录时如实说算不出来，不能只算输出费用还说算全了。
	unknown := &costProbe{
		doc: costCanvasWith([]map[string]any{
			costNode("ref", "video", "", map[string]any{"content": "https://example.test/ref.mp4"}),
			costNode("n1", "video", "beefapi::wan3.0-video", map[string]any{"vquality": "720", "seconds": 5}),
		}, [][2]string{{"ref", "n1"}}),
		pricing: map[string]map[string]any{"beefapi::wan3.0-video": wan},
	}
	result, err = opCanvasCostEstimate(&Context{UserID: "owner", Domain: unknown}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary = result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if summary.Items[0].Amount != nil || summary.Items[0].Basis != "参考视频时长读不到，无法估算" || summary.Known {
		t.Fatalf("参考视频时长读不到 = %#v", summary.Items[0])
	}
}

func TestOpCanvasCostEstimateAudioUsesSpeechText(t *testing.T) {
	probe := &costProbe{
		doc:     costCanvas(),
		pricing: map[string]map[string]any{"beefapi::minimax-speech-2.8-hd": {"currency": "CNY", "kind": "audio", "mode": "tokens", "input_cny": 350}},
	}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","batch":{"kind":"audio","model":"beefapi::minimax-speech-2.8-hd","items":[{"text":"你好世界"}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if summary.Total != 0.0014 || summary.Items[0].Basis != "约 ¥350/百万字 × 4 字" {
		t.Fatalf("audio summary = %#v", summary)
	}
	// 没有台词文本时不能按 0 字算成 0 元。
	result, err = opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","batch":{"kind":"audio","model":"beefapi::minimax-speech-2.8-hd","count":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	summary = result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if summary.Items[0].Amount != nil || summary.Items[0].Basis != "缺少台词文本" || summary.Known {
		t.Fatalf("audio without text = %#v", summary)
	}
}

func TestOpCanvasCostEstimateRejectsBadArguments(t *testing.T) {
	probe := &costProbe{doc: costCanvas()}
	for name, params := range map[string]string{
		"缺少画布":  `{}`,
		"类型不合法": `{"canvasId":"c1","batch":{"kind":"text","model":"beefapi::gpt-image-2"}}`,
		"未知参数":  `{"canvasId":"c1","userId":"other"}`,
	} {
		result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(params))
		if err == nil || result != nil {
			t.Fatalf("%s 应被拒绝: result=%v err=%v", name, result, err)
		}
	}
}

func TestOpCanvasCostEstimateWithoutPricingPortStaysUnavailable(t *testing.T) {
	// proposeProbe 只实现画布读取与模型解析，没有目录单价端口。
	probe := &proposeProbe{doc: costCanvas(costNode("n1", "image", "beefapi::gpt-image-2", nil))}
	result, err := opCanvasCostEstimate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["estimate"] != nil || payload["unavailable"] != "当前工作区没有可用的目录单价" {
		t.Fatalf("没有目录单价端口时应如实说明: %#v", payload)
	}
}

type costProposeProbe struct {
	*proposeProbe
	pricing map[string]map[string]any
}

func (p *costProposeProbe) ModelCostPricing(modelKey string) (map[string]any, bool) {
	pricing, ok := p.pricing[modelKey]
	return pricing, ok
}

func TestOpGenerationProposeCarriesCostEstimate(t *testing.T) {
	probe := &costProposeProbe{
		proposeProbe: &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", "beefapi::gpt-image-2")})},
		pricing:      map[string]map[string]any{"beefapi::gpt-image-2": imagePricingTable()},
	}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary, ok := result.(map[string]any)["estimate"].(*modelcatalog.CostSummary)
	if !ok || summary == nil || summary.Total != 0.35 || summary.Items[0].NodeID != "n1" {
		t.Fatalf("提议卡需要带上费用估算: %#v", result)
	}
}
