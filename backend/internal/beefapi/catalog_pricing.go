package beefapi

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
)

// EnterpriseCatalogPath 是企业价格目录：与模型列表同源、无需登录，包含图片、
// 视频、配音和音乐的实际单价。它只作为模型档案里的参考单价保存，目录改价后要
// 等下一次刷新模型目录才会同步。
const EnterpriseCatalogPath = "/api/enterprise/catalog"

type enterpriseCatalogPayload struct {
	Data struct {
		Currency string            `json:"currency"`
		Models   []json.RawMessage `json:"models"`
	} `json:"data"`
}

// catalogImagePriceTable 按质量 × 分辨率列价，参考图单价另列。
type catalogImagePriceTable struct {
	Currency       string                        `json:"currency"`
	Output         map[string]map[string]float64 `json:"output"`
	Reference      *float64                      `json:"reference"`
	DefaultQuality string                        `json:"default_quality"`
	DefaultSize    string                        `json:"default_size"`
	AutoQuality    string                        `json:"auto_quality"`
}

type catalogVideoOfficialRate struct {
	Resolution         string  `json:"resolution"`
	InputPerSecondCNY  float64 `json:"input_per_second_cny"`
	OutputPerSecondCNY float64 `json:"output_per_second_cny"`
}

// catalogPricingRow 只声明算价要用的字段；目录里的说明文字不进入客户端。
type catalogPricingRow struct {
	ModelName           string                     `json:"model_name"`
	DisplayKind         string                     `json:"display_kind"`
	Mode                string                     `json:"mode"`
	PerRequestCNY       *float64                   `json:"per_request_cny"`
	PerSecondCNY        map[string]float64         `json:"per_second_cny"`
	VideoInputPerSecond map[string]float64         `json:"video_input_per_second_cny"`
	ReferenceImageCNY   *float64                   `json:"reference_image_cny"`
	FreeReferenceImages *int                       `json:"free_reference_images"`
	InputCNY            *float64                   `json:"input_cny"`
	OutputCNY           *float64                   `json:"output_cny"`
	VideoOfficial       []catalogVideoOfficialRate `json:"video_official"`
	ImagePriceTable     *catalogImagePriceTable    `json:"image_price_table"`
}

// ParseEnterpriseCatalog 把价格目录按 model_name 索引。目录整体不可读时返回 nil；
// 单行读不懂就跳过该行，不影响其他模型。
func ParseEnterpriseCatalog(raw []byte) map[string]map[string]any {
	var payload enterpriseCatalogPayload
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil || payload.Data.Currency != "CNY" {
		return nil
	}
	prices := make(map[string]map[string]any, len(payload.Data.Models))
	for _, item := range payload.Data.Models {
		name, pricing, ok := NormalizeCatalogPricing(item)
		if !ok {
			continue
		}
		prices[name] = pricing
	}
	return prices
}

// NormalizeCatalogPricing 把价格目录的一行归一成模型档案里的 pricing：只保留算价
// 要用的字段，目录没有的字段不写。文字模型和超分参考价不算画布的可计费项。
func NormalizeCatalogPricing(raw json.RawMessage) (string, map[string]any, bool) {
	var row catalogPricingRow
	if len(raw) == 0 || json.Unmarshal(raw, &row) != nil {
		return "", nil, false
	}
	name := strings.TrimSpace(row.ModelName)
	kind := strings.ToLower(strings.TrimSpace(row.DisplayKind))
	if name == "" || (kind != "image" && kind != "video" && kind != "audio") {
		return "", nil, false
	}
	pricing := map[string]any{"currency": "CNY", "kind": kind}
	if mode := strings.TrimSpace(row.Mode); mode != "" {
		pricing["mode"] = mode
	}
	if value, ok := pricingNumber(row.PerRequestCNY); ok {
		pricing["per_request_cny"] = value
	}
	if rates := pricingRates(row.PerSecondCNY); len(rates) > 0 {
		pricing["per_second_cny"] = rates
	}
	if rates := pricingRates(row.VideoInputPerSecond); len(rates) > 0 {
		pricing["video_input_per_second_cny"] = rates
	}
	if value, ok := pricingNumber(row.ReferenceImageCNY); ok {
		pricing["reference_image_cny"] = value
	}
	if row.FreeReferenceImages != nil && *row.FreeReferenceImages >= 0 {
		pricing["free_reference_images"] = *row.FreeReferenceImages
	}
	if value, ok := pricingNumber(row.InputCNY); ok {
		pricing["input_cny"] = value
	}
	if value, ok := pricingNumber(row.OutputCNY); ok {
		pricing["output_cny"] = value
	}
	if official := pricingOfficialRates(row.VideoOfficial); len(official) > 0 {
		pricing["video_official"] = official
	}
	if table := pricingImageTable(row.ImagePriceTable); table != nil {
		pricing["image_price_table"] = table
	}
	if len(pricing) <= 2 {
		// 只剩 currency/kind，说明这一行没有任何可用的计费字段。
		return "", nil, false
	}
	return name, pricing, true
}

func pricingImageTable(raw *catalogImagePriceTable) map[string]any {
	if raw == nil || (raw.Currency != "" && raw.Currency != "CNY") {
		return nil
	}
	output := map[string]any{}
	for quality, sizes := range raw.Output {
		if strings.TrimSpace(quality) == "" {
			continue
		}
		tiers := map[string]any{}
		for size, price := range sizes {
			if strings.TrimSpace(size) == "" || !finiteNonNegative(price) {
				continue
			}
			tiers[size] = price
		}
		if len(tiers) > 0 {
			output[quality] = tiers
		}
	}
	table := map[string]any{}
	if len(output) > 0 {
		table["output"] = output
	}
	if value, ok := pricingNumber(raw.Reference); ok {
		table["reference"] = value
	}
	for key, value := range map[string]string{
		"default_quality": raw.DefaultQuality,
		"default_size":    raw.DefaultSize,
		"auto_quality":    raw.AutoQuality,
	} {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			table[key] = trimmed
		}
	}
	if len(table) == 0 {
		return nil
	}
	return table
}

func pricingOfficialRates(rows []catalogVideoOfficialRate) []any {
	rates := make([]any, 0, len(rows))
	for _, row := range rows {
		resolution := strings.ToLower(strings.TrimSpace(row.Resolution))
		if resolution == "" || !finiteNonNegative(row.OutputPerSecondCNY) || !finiteNonNegative(row.InputPerSecondCNY) {
			continue
		}
		rates = append(rates, map[string]any{
			"resolution":            resolution,
			"input_per_second_cny":  row.InputPerSecondCNY,
			"output_per_second_cny": row.OutputPerSecondCNY,
		})
	}
	return rates
}

func pricingRates(raw map[string]float64) map[string]any {
	rates := map[string]any{}
	for resolution, rate := range raw {
		key := strings.ToLower(strings.TrimSpace(resolution))
		if key == "" || !finiteNonNegative(rate) {
			continue
		}
		rates[key] = rate
	}
	return rates
}

func pricingNumber(value *float64) (float64, bool) {
	if value == nil || !finiteNonNegative(*value) {
		return 0, false
	}
	return *value, true
}

func finiteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

// fetchEnterprisePricing 读取企业价格目录。价格目录只是参考单价：读失败、超时或
// 格式变化都不写价格，也不影响模型列表本身。
func (s *Service) fetchEnterprisePricing() map[string]map[string]any {
	request, err := http.NewRequestWithContext(s.lifecycle, http.MethodGet, ProviderBaseURL(s.Origin())+EnterpriseCatalogPath, nil)
	if err != nil {
		return nil
	}
	request.Header.Set("Accept", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil
	}
	return ParseEnterpriseCatalog(raw)
}
