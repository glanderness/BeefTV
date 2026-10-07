package beefapi

import (
	"encoding/json"
	"math"
)

func NormalizeCatalogVideoPricing(raw json.RawMessage) (map[string]any, bool) {
	var value struct {
		Currency string `json:"currency"`
		Mode     string `json:"mode"`
		Rates    map[string]struct {
			Output         float64 `json:"output"`
			ReferenceVideo float64 `json:"reference_video"`
		} `json:"rates"`
	}
	if json.Unmarshal(raw, &value) != nil || value.Currency != "CNY" || value.Mode != "tokens" || len(value.Rates) == 0 {
		return nil, false
	}
	rates := map[string]any{}
	for resolution, rate := range value.Rates {
		if resolution != "480p" && resolution != "720p" && resolution != "1080p" && resolution != "4k" {
			return nil, false
		}
		if rate.Output <= 0 || rate.ReferenceVideo <= 0 || math.IsNaN(rate.Output) || math.IsInf(rate.Output, 0) || math.IsNaN(rate.ReferenceVideo) || math.IsInf(rate.ReferenceVideo, 0) {
			return nil, false
		}
		rates[resolution] = map[string]any{"output": rate.Output, "reference_video": rate.ReferenceVideo}
	}
	return map[string]any{"currency": "CNY", "mode": "tokens", "rates": rates}, true
}
