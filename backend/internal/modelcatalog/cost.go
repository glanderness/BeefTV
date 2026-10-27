package modelcatalog

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// CostLine 是一个生成目标的目录单价估算。Amount 为 nil 表示暂无价格：
// 界面和助手都必须显示原因，不能当成 0 元。
type CostLine struct {
	NodeID string   `json:"nodeId,omitempty"`
	Title  string   `json:"title,omitempty"`
	Kind   string   `json:"kind"`
	Model  string   `json:"model,omitempty"`
	Amount *float64 `json:"amount"`
	Basis  string   `json:"basis"`
}

// CostSummary 是若干目标的合计。它是目录单价的估算，不是账单；只有金额已知的项
// 计入 Total，算不出的项单独计数。
type CostSummary struct {
	Currency     string     `json:"currency"`
	Total        float64    `json:"total"`
	Known        bool       `json:"known"`
	UnknownCount int        `json:"unknownCount"`
	Items        []CostLine `json:"items"`
	Text         string     `json:"text"`
}

// CostRequest 是一次费用估算的输入。Pricing 是模型档案里保存的目录单价，
// Parameters 是节点当前的生成参数，Text 是配音按字数计费时的台词。
type CostRequest struct {
	Kind           string
	Model          string
	Pricing        map[string]any
	Parameters     map[string]string
	ReferenceCount int
	Text           string
}

// upscaleModelPrefixes 是超分模型：目录里的 per_request_cny 是超分的先扣参考价，
// 不是图片价，按超分单独结算，不计入画布合计。
var upscaleModelPrefixes = []string{"topaz-"}

// EstimateCost 按目录字段直接算单项费用，不猜目录没有的数字。
func EstimateCost(request CostRequest) CostLine {
	line := CostLine{Kind: request.Kind, Model: request.Model}
	if len(request.Pricing) == 0 {
		line.Basis = "暂无价格"
		return line
	}
	if isUpscaleModel(request.Model) {
		line.Basis = "超分按先扣金额结算，不计入合计"
		return line
	}
	switch request.Kind {
	case "image":
		return estimateImageCost(line, request)
	case "video":
		return estimateVideoCost(line, request)
	case "audio":
		return estimateAudioCost(line, request)
	default:
		line.Basis = "暂无价格"
		return line
	}
}

func estimateImageCost(line CostLine, request CostRequest) CostLine {
	count := parameterCount(request.Parameters)
	table := mapOf(request.Pricing["image_price_table"])
	if len(table) > 0 {
		quality := imagePriceQuality(request.Parameters["quality"], table)
		tier := imagePriceTier(request.Parameters["size"], table)
		if price, ok := imageTablePrice(table, quality, tier); ok {
			amount := price * float64(count)
			basis := fmt.Sprintf("%s ¥%s × %d 张", imagePriceLabel(tier, quality), formatMoney(price), count)
			if reference, ok := floatOf(table["reference"]); ok && reference > 0 && request.ReferenceCount > 0 {
				paid := request.ReferenceCount - intOf(request.Pricing["free_reference_images"])
				if paid > 0 {
					amount += reference * float64(paid)
					basis += fmt.Sprintf(" + 参考图 ¥%s × %d 张", formatMoney(reference), paid)
				}
			}
			line.Amount = money(amount)
			line.Basis = basis
			return line
		}
	}
	if price, ok := floatOf(request.Pricing["per_request_cny"]); ok {
		line.Amount = money(price * float64(count))
		line.Basis = fmt.Sprintf("按基础价 ¥%s × %d 张", formatMoney(price), count)
		return line
	}
	line.Basis = "图片价格暂不可用"
	return line
}

func estimateVideoCost(line CostLine, request CostRequest) CostLine {
	seconds, hasSeconds := floatOf(parameterString(request.Parameters, "seconds"))
	count := parameterCount(request.Parameters)
	rates := mapOf(request.Pricing["per_second_cny"])
	if len(rates) > 0 {
		resolution := videoPriceResolution(parameterString(request.Parameters, "vquality"), rates)
		rate, ok := floatOf(rates[resolution])
		if resolution == "" || !ok {
			line.Basis = "分辨率没有对应报价"
			return line
		}
		if !hasSeconds || seconds <= 0 {
			line.Basis = fmt.Sprintf("%s ¥%s/秒，缺少时长", resolution, formatMoney(rate))
			return line
		}
		amount := rate * seconds * float64(count)
		basis := fmt.Sprintf("%s ¥%s/秒 × %s秒", resolution, formatMoney(rate), formatSeconds(seconds))
		if count > 1 {
			basis += fmt.Sprintf(" × %d 个", count)
		}
		if reference, ok := floatOf(request.Pricing["reference_image_cny"]); ok && reference > 0 {
			paid := request.ReferenceCount - intOf(request.Pricing["free_reference_images"])
			if paid > 0 {
				amount += reference * float64(paid)
				basis += fmt.Sprintf(" + 参考图 ¥%s × %d 张", formatMoney(reference), paid)
			}
		}
		line.Amount = money(amount)
		line.Basis = basis
		return line
	}
	if official := videoOfficialRate(request.Pricing, parameterString(request.Parameters, "vquality")); official != nil {
		if !hasSeconds || seconds <= 0 {
			line.Basis = fmt.Sprintf("%s 约 ¥%s/秒，缺少时长", official.resolution, formatMoney(official.output))
			return line
		}
		amount := official.output * seconds * float64(count)
		basis := fmt.Sprintf("%s 约 ¥%s/秒 × %s秒（按 Token 折算）", official.resolution, formatMoney(official.output), formatSeconds(seconds))
		if count > 1 {
			basis += fmt.Sprintf(" × %d 个", count)
		}
		line.Amount = money(amount)
		line.Basis = basis
		return line
	}
	line.Basis = "按视频 Token 计费，暂无法折算成每次价格"
	return line
}

func estimateAudioCost(line CostLine, request CostRequest) CostLine {
	count := parameterCount(request.Parameters)
	if price, ok := floatOf(request.Pricing["per_request_cny"]); ok {
		line.Amount = money(price * float64(count))
		line.Basis = fmt.Sprintf("¥%s/次 × %d 次", formatMoney(price), count)
		return line
	}
	if price, ok := floatOf(request.Pricing["input_cny"]); ok {
		characters := len([]rune(strings.TrimSpace(request.Text)))
		if characters == 0 {
			line.Basis = "缺少台词文本"
			return line
		}
		line.Amount = money(price / 1_000_000 * float64(characters))
		line.Basis = fmt.Sprintf("约 ¥%s/百万字 × %d 字", formatMoney(price), characters)
		return line
	}
	line.Basis = "配音价格暂不可用"
	return line
}

// SumCostLines 把逐项估算合成一个合计。
func SumCostLines(items []CostLine) CostSummary {
	summary := CostSummary{Currency: "CNY", Items: items}
	known := 0
	for _, item := range items {
		if item.Amount == nil {
			summary.UnknownCount++
			continue
		}
		summary.Total += *item.Amount
		known++
	}
	summary.Total = roundMoney(summary.Total)
	summary.Known = len(items) > 0 && summary.UnknownCount == 0
	switch {
	case len(items) == 0:
		summary.Text = "画布上还没有可估算费用的生成节点"
	case summary.UnknownCount == 0:
		summary.Text = fmt.Sprintf("预计费用 ¥%s", formatMoney(summary.Total))
	case known == 0:
		summary.Text = "暂无可用价格，按所选渠道实际标准计费"
	default:
		summary.Text = fmt.Sprintf("预计费用 ¥%s（已知部分），另有 %d 项暂无价格", formatMoney(summary.Total), summary.UnknownCount)
	}
	return summary
}

// imagePriceQuality 把节点上的质量参数对到价表的质量档；auto 用价表的默认档。
func imagePriceQuality(value string, table map[string]any) string {
	output := mapOf(table["output"])
	quality := strings.ToLower(strings.TrimSpace(value))
	if quality == "" || quality == "auto" || quality == "any" {
		quality = strings.ToLower(strings.TrimSpace(stringOf(table["default_quality"])))
	}
	if quality == "auto" {
		quality = strings.ToLower(strings.TrimSpace(stringOf(table["auto_quality"])))
	}
	if _, ok := output[quality]; ok {
		return quality
	}
	fallback := strings.ToLower(strings.TrimSpace(stringOf(table["default_quality"])))
	if _, ok := output[fallback]; ok {
		return fallback
	}
	return ""
}

// imagePriceTier 把节点上的尺寸参数对到价表的 1K/2K/4K 档：比例交给价表默认档，
// 像素尺寸按长边归档。
func imagePriceTier(value string, table map[string]any) string {
	output := mapOf(table["output"])
	quality := imagePriceQuality("", table)
	tiers := mapOf(output[quality])
	requested := strings.ToUpper(strings.TrimSpace(value))
	if requested == "" || requested == "AUTO" || strings.Contains(requested, ":") {
		requested = strings.ToUpper(strings.TrimSpace(stringOf(table["default_size"])))
	}
	if _, ok := tiers[requested]; ok {
		return requested
	}
	if width, height, ok := parsePixelSize(requested); ok {
		side := max(width, height)
		switch {
		case side >= 3000:
			return "4K"
		case side >= 1500:
			return "2K"
		default:
			return "1K"
		}
	}
	return ""
}

func imageTablePrice(table map[string]any, quality string, tier string) (float64, bool) {
	if quality == "" || tier == "" {
		return 0, false
	}
	tiers := mapOf(mapOf(table["output"])[quality])
	return floatOf(tiers[tier])
}

func imagePriceLabel(tier string, quality string) string {
	label := strings.TrimSpace(tier)
	if name, ok := imageQualityLabels[quality]; ok {
		label = strings.TrimSpace(label + " " + name + "质量")
	}
	return label
}

var imageQualityLabels = map[string]string{
	"low":      "低",
	"medium":   "中",
	"high":     "高",
	"xhigh":    "极高",
	"max":      "最高",
	"standard": "标准",
	"layers":   "图层",
}

// videoPriceResolution 把节点上的分辨率参数对到目录的键；参数为空（自动）时按
// 目录里最常用的档位取一个参考价，与已有的视频单价显示保持一致。
func videoPriceResolution(value string, rates map[string]any) string {
	key := strings.ToLower(strings.TrimSpace(value))
	if alias, ok := videoResolutionAliases[key]; ok {
		key = alias
	}
	if key != "" {
		if _, ok := rates[key]; ok {
			return key
		}
		return ""
	}
	for _, candidate := range []string{"720p", "1080p"} {
		if _, ok := rates[candidate]; ok {
			return candidate
		}
	}
	keys := make([]string, 0, len(rates))
	for resolution := range rates {
		keys = append(keys, resolution)
	}
	sort.Strings(keys)
	if len(keys) > 0 {
		return keys[0]
	}
	return ""
}

var videoResolutionAliases = map[string]string{"2160p": "4k", "1440p": "2k"}

type videoOfficialQuote struct {
	resolution string
	output     float64
}

func videoOfficialRate(pricing map[string]any, value string) *videoOfficialQuote {
	rows, _ := pricing["video_official"].([]any)
	if len(rows) == 0 {
		return nil
	}
	byResolution := map[string]float64{}
	for _, row := range rows {
		item := mapOf(row)
		resolution := strings.ToLower(strings.TrimSpace(stringOf(item["resolution"])))
		output, ok := floatOf(item["output_per_second_cny"])
		if resolution == "" || !ok {
			continue
		}
		byResolution[resolution] = output
	}
	rates := map[string]any{}
	for resolution, output := range byResolution {
		rates[resolution] = output
	}
	resolution := videoPriceResolution(value, rates)
	output, ok := byResolution[resolution]
	if resolution == "" || !ok {
		return nil
	}
	return &videoOfficialQuote{resolution: resolution, output: output}
}

func isUpscaleModel(model string) bool {
	lower := strings.ToLower(strings.TrimSpace(model))
	if index := strings.LastIndex(lower, "::"); index >= 0 {
		lower = lower[index+2:]
	}
	lower = strings.TrimPrefix(lower, "/")
	for _, prefix := range upscaleModelPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func parameterCount(parameters map[string]string) int {
	count := intOf(parameters["count"])
	if count < 1 {
		return 1
	}
	return count
}

func parameterString(parameters map[string]string, key string) string {
	if parameters == nil {
		return ""
	}
	return parameters[key]
}

func mapOf(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func floatOf(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func intOf(value any) int {
	number, ok := floatOf(value)
	if !ok {
		return 0
	}
	return int(number)
}

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

func parsePixelSize(value string) (int, int, bool) {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(value)), "x", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, errWidth := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, errHeight := strconv.Atoi(strings.TrimSpace(parts[1]))
	if errWidth != nil || errHeight != nil || width <= 0 || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func money(value float64) *float64 {
	rounded := roundMoney(value)
	return &rounded
}

func roundMoney(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// formatMoney 去掉多余的零：1.4000 → 1.4，0.35000 → 0.35。
func formatMoney(value float64) string {
	return strconv.FormatFloat(roundMoney(value), 'f', -1, 64)
}

func formatSeconds(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
