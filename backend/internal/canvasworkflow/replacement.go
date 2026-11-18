package canvasworkflow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"infinite-canvas/backend/internal/modelcatalog"
	"math"
	"sort"
	"strings"
)

const CharacterReplacementOperation = "video.replace-character"

const ReplacementPrepareOperation = "video.replacement-prepare"
const ReplacementFinishOperation = "video.replacement-finish"

type ReplacementLimits struct {
	MinSeconds     int      `json:"minSeconds"`
	MaxSeconds     int      `json:"maxSeconds"`
	MinRefSeconds  int      `json:"minRefSeconds"`
	Resolutions    []string `json:"resolutions"`
	DefaultQuality string   `json:"defaultQuality"`
	MaxImageBytes  int64    `json:"maxImageBytes"`
	MaxVideoBytes  int64    `json:"maxVideoBytes"`
	MinVideoWidth  int      `json:"minVideoWidth"`
	MaxVideoWidth  int      `json:"maxVideoWidth"`
	MinVideoHeight int      `json:"minVideoHeight"`
	MaxVideoHeight int      `json:"maxVideoHeight"`
	MinVideoAspect float64  `json:"minVideoAspect"`
	MaxVideoAspect float64  `json:"maxVideoAspect"`
}

func DefaultReplacementLimits() ReplacementLimits {
	return ReplacementLimits{
		MinSeconds:     4,
		MaxSeconds:     15,
		MinRefSeconds:  2,
		Resolutions:    []string{"720p", "480p"},
		DefaultQuality: "720p",
		MaxImageBytes:  30 * 1024 * 1024,
		MaxVideoBytes:  50 * 1024 * 1024,
		MinVideoWidth:  2,
		MaxVideoWidth:  8192,
		MinVideoHeight: 2,
		MaxVideoHeight: 8192,
		MinVideoAspect: 0.4,
		MaxVideoAspect: 2.5,
	}
}

func isUnsupported25ReplacementSKU(modelName string) bool {
	lower := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(lower, "seedance-2.5") || strings.Contains(lower, "seedance-2-5")
}

func isKnownSeedance20FastSKU(modelName string) bool {
	normalized := strings.ToLower(strings.TrimSpace(modelName))
	if idx := strings.LastIndex(normalized, "/"); idx >= 0 {
		normalized = normalized[idx+1:]
	}
	return normalized == "seedance-2.0-fast" ||
		normalized == "doubao-seedance-2-0-fast" || strings.HasPrefix(normalized, "doubao-seedance-2-0-fast-") ||
		normalized == "dreamina-seedance-2-0-fast" || strings.HasPrefix(normalized, "dreamina-seedance-2-0-fast-")
}

// ResolveReplacementCapability fails closed when capability metadata is missing,
// malformed, or lacks reference_to_video + video/image reference + duration/resolution support.
// Only explicit persisted CapabilityConfig is accepted for arbitrary models/endpoints;
// raw == nil is accepted solely for known Seedance 2.0 Fast SKUs with a non-empty protocol.
func ResolveReplacementCapability(protocol, modelName string, raw any) (ReplacementLimits, bool) {
	if isUnsupported25ReplacementSKU(modelName) {
		return ReplacementLimits{}, false
	}
	var cfg *modelcatalog.ModelCapabilityConfig
	if raw != nil {
		switch v := raw.(type) {
		case *modelcatalog.ModelCapabilityConfig:
			if v == nil {
				return ReplacementLimits{}, false
			}
			cfg = v
		case modelcatalog.ModelCapabilityConfig:
			cfg = &v
		default:
			encoded, err := json.Marshal(raw)
			if err != nil || bytes.Equal(bytes.TrimSpace(encoded), []byte("null")) {
				return ReplacementLimits{}, false
			}
			var parsed modelcatalog.ModelCapabilityConfig
			dec := json.NewDecoder(bytes.NewReader(encoded))
			if err := dec.Decode(&parsed); err != nil {
				return ReplacementLimits{}, false
			}
			cfg = &parsed
		}
	} else {
		if strings.TrimSpace(protocol) == "" || !isKnownSeedance20FastSKU(modelName) {
			return ReplacementLimits{}, false
		}
		cfg = modelcatalog.DefaultModelCapabilityConfigForModel(protocol, modelName)
	}
	if cfg == nil || cfg.Video == nil || !modelcatalog.VideoDurationSupported(cfg.Video) {
		return ReplacementLimits{}, false
	}
	video := cfg.Video
	hasRefOp := false
	for _, op := range video.Operations {
		if op == "reference_to_video" {
			hasRefOp = true
			break
		}
	}
	if !hasRefOp {
		return ReplacementLimits{}, false
	}
	refs := modelcatalog.VideoReferencesForOperation(video, "reference_to_video")
	// Single-character replacement supplies 1 video and 1 character image.
	if refs.MaxVideos < 1 || refs.MaxImages < 1 || refs.MinImages > 1 {
		return ReplacementLimits{}, false
	}
	limits := DefaultReplacementLimits()
	if refs.MinVideoDuration > 0 {
		limits.MinRefSeconds = refs.MinVideoDuration
	}
	if refs.MaxImageBytes > 0 {
		limits.MaxImageBytes = refs.MaxImageBytes
	}
	if refs.MaxVideoBytes > 0 {
		limits.MaxVideoBytes = refs.MaxVideoBytes
	}
	if refs.MinVideoWidth > 0 {
		limits.MinVideoWidth = max(limits.MinVideoWidth, refs.MinVideoWidth)
	}
	if refs.MaxVideoWidth > 0 {
		limits.MaxVideoWidth = min(limits.MaxVideoWidth, refs.MaxVideoWidth)
	}
	if refs.MinVideoHeight > 0 {
		limits.MinVideoHeight = max(limits.MinVideoHeight, refs.MinVideoHeight)
	}
	if refs.MaxVideoHeight > 0 {
		limits.MaxVideoHeight = min(limits.MaxVideoHeight, refs.MaxVideoHeight)
	}
	if refs.MinVideoAspect > 0 {
		limits.MinVideoAspect = math.Max(limits.MinVideoAspect, refs.MinVideoAspect)
	}
	if refs.MaxVideoAspect > 0 {
		limits.MaxVideoAspect = math.Min(limits.MaxVideoAspect, refs.MaxVideoAspect)
	}
	if limits.MinVideoWidth > limits.MaxVideoWidth || limits.MinVideoHeight > limits.MaxVideoHeight || limits.MinVideoAspect > limits.MaxVideoAspect {
		return ReplacementLimits{}, false
	}

	minDur, maxDur, ok := contiguousDurationWindow(video.Duration)
	if !ok {
		return ReplacementLimits{}, false
	}
	if refs.MaxVideoDuration > 0 && refs.MaxVideoDuration < maxDur {
		maxDur = refs.MaxVideoDuration
	}
	if maxDur > 15 {
		maxDur = 15
	}
	if minDur < limits.MinRefSeconds {
		minDur = limits.MinRefSeconds
	}
	if minDur < 1 || maxDur < max(minDur, 5) || limits.MinRefSeconds > maxDur {
		return ReplacementLimits{}, false
	}
	limits.MinSeconds = minDur
	limits.MaxSeconds = maxDur

	supportedRes := []string{}
	seenRes := map[string]bool{}
	for _, r := range video.Resolutions {
		norm := strings.ToLower(strings.TrimSpace(r))
		if (norm == "480p" || norm == "720p") && !seenRes[norm] {
			seenRes[norm] = true
			supportedRes = append(supportedRes, norm)
		}
	}
	if len(supportedRes) == 0 {
		return ReplacementLimits{}, false
	}
	limits.Resolutions = supportedRes
	if seenRes["720p"] {
		limits.DefaultQuality = "720p"
	} else {
		limits.DefaultQuality = supportedRes[0]
	}
	return limits, true
}

func contiguousDurationWindow(d modelcatalog.VideoDurationConfig) (int, int, bool) {
	if d.Selection == "enum" {
		if len(d.Values) == 0 {
			return 0, 0, false
		}
		vals := append([]int(nil), d.Values...)
		sort.Ints(vals)
		bestStart, bestEnd := vals[0], vals[0]
		curStart, curEnd := vals[0], vals[0]
		for i := 1; i < len(vals); i++ {
			if vals[i] == curEnd {
				continue
			}
			if vals[i] == curEnd+1 {
				curEnd = vals[i]
			} else {
				if curEnd-curStart > bestEnd-bestStart {
					bestStart, bestEnd = curStart, curEnd
				}
				curStart, curEnd = vals[i], vals[i]
			}
		}
		if curEnd-curStart > bestEnd-bestStart {
			bestStart, bestEnd = curStart, curEnd
		}
		return bestStart, bestEnd, bestEnd >= bestStart && bestEnd > 0
	}
	if d.Step > 1 {
		return 0, 0, false
	}
	minVal := max(1, d.Min)
	return minVal, d.Max, d.Max >= minVal
}

func (l ReplacementLimits) SupportsQuality(q string) bool {
	norm := strings.ToLower(strings.TrimSpace(q))
	for _, r := range l.Resolutions {
		if r == norm {
			return true
		}
	}
	return false
}

func (l ReplacementLimits) Validate() error {
	if l.MinRefSeconds < 1 || l.MinSeconds < l.MinRefSeconds || l.MaxSeconds < max(l.MinSeconds, 5) || l.MaxSeconds > 15 {
		return fmt.Errorf("人物替换模型时长配置无效")
	}
	if l.MinVideoWidth < 2 || l.MinVideoHeight < 2 || l.MaxVideoWidth < l.MinVideoWidth || l.MaxVideoHeight < l.MinVideoHeight || l.MinVideoAspect <= 0 || l.MaxVideoAspect < l.MinVideoAspect || l.MaxVideoBytes <= 0 || l.MaxImageBytes <= 0 {
		return fmt.Errorf("人物替换模型媒体上限配置无效")
	}
	return nil
}

// ReferenceScaleDimensions computes even reference video dimensions satisfying per-axis bounds.
func (l ReplacementLimits) ReferenceScaleDimensions(width, height int) (int, int, error) {
	if err := l.Validate(); err != nil {
		return 0, 0, err
	}
	w, h := float64(width), float64(height)
	if width <= 0 || height <= 0 {
		return 0, 0, fmt.Errorf("视频缺少有效宽高")
	}
	scaleMin := math.Max(float64(l.MinVideoWidth)/w, float64(l.MinVideoHeight)/h)
	scaleMax := math.Min(float64(l.MaxVideoWidth)/w, float64(l.MaxVideoHeight)/h)
	if scaleMin > scaleMax {
		return 0, 0, fmt.Errorf("原视频尺寸无法缩放到模型要求的参考宽高范围")
	}
	desired := math.Max(1.0, math.Max(300.0/float64(min(width, height)), math.Sqrt(409600.0/(w*h))))
	if cap2000 := 2000.0 / float64(max(width, height)); cap2000 < desired {
		desired = cap2000
	}
	scale := math.Min(math.Max(desired, scaleMin), scaleMax)
	rw := int(math.Round(w*scale/2.0)) * 2
	rh := int(math.Round(h*scale/2.0)) * 2
	minEvenW, maxEvenW := (l.MinVideoWidth+1)/2*2, l.MaxVideoWidth/2*2
	minEvenH, maxEvenH := (l.MinVideoHeight+1)/2*2, l.MaxVideoHeight/2*2
	rw = min(maxEvenW, max(minEvenW, rw))
	rh = min(maxEvenH, max(minEvenH, rh))
	if rw < l.MinVideoWidth || rw > l.MaxVideoWidth || rh < l.MinVideoHeight || rh > l.MaxVideoHeight {
		return 0, 0, fmt.Errorf("参考片段缩放尺寸超出模型要求范围")
	}
	return rw, rh, nil
}

func IsReplacementLocalOperation(id string) bool {
	return id == ReplacementPrepareOperation || id == ReplacementFinishOperation
}

func replacementLocalOperations() []Operation {
	return []Operation{
		{ID: ReplacementPrepareOperation, Version: 1, Name: "准备人物替换片段", OutputType: "text", Inputs: []InputPort{{"video", "原视频", "video", true, false}}, Fields: []Field{{Key: "maxSegments", Label: "片段上限", Type: "number"}, {Key: "minSeconds", Label: "最小时长", Type: "number"}, {Key: "maxSeconds", Label: "最大时长", Type: "number"}, {Key: "limits", Label: "能力上限", Type: "string"}}},
		{ID: ReplacementFinishOperation, Version: 1, Name: "恢复人物替换时间轴", OutputType: "video", Inputs: []InputPort{{"video", "原视频", "video", true, false}}, Fields: []Field{{Key: "manifest", Label: "已完成片段记录", Type: "string"}}},
	}
}

func ReplacementManifest(n Node) (ReplacementPlan, error) {
	var p ReplacementPlan
	text, _ := n.Config["manifest"].(string)
	if len(text) == 0 || len(text) > 256*1024 || json.Unmarshal([]byte(text), &p) != nil {
		return p, fmt.Errorf("人物替换片段记录无法读取")
	}
	return p, ValidatePreparedReplacementPlan(p, true)
}

func characterReplacementOperation() Operation {
	minSeg, maxSeg := 1.0, 100.0
	return Operation{
		ID: CharacterReplacementOperation, Version: 1, Name: "单人物替换", OutputType: "video",
		Inputs: []InputPort{{"video", "原视频", "video", true, false}, {"character", "目标人物", "image", true, false}},
		Fields: []Field{
			{Key: "modelOption", Label: "模型", Type: "select"},
			{Key: "vquality", Label: "生成清晰度", Type: "select", Options: []FieldOption{{Label: "720p", Value: "720p"}, {Label: "480p", Value: "480p"}}},
			{Key: "maxSegments", Label: "最多生成片段数（默认12）", Type: "number", Min: &minSeg, Max: &maxSeg},
			{Key: "instructions", Label: "补充要求（可选）", Type: "textarea"},
		},
	}
}

func ValidateCharacterReplacement(n Node) error {
	option := strings.TrimSpace(fmt.Sprint(n.Config["modelOption"]))
	parts := strings.SplitN(option, "::", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" || isUnsupported25ReplacementSKU(parts[1]) {
		return fmt.Errorf("单人物替换请选择已启用且支持视频与图片参考的模型")
	}
	if value, ok := n.Config["maxSegments"]; ok {
		count := operationNumber(value)
		if math.IsNaN(count) || math.IsInf(count, 0) || count < 1 || count > 100 || math.Trunc(count) != count {
			return fmt.Errorf("最多生成片段数需为1到100的整数")
		}
	}
	if quality, ok := n.Config["vquality"].(string); ok && quality != "720p" && quality != "480p" {
		return fmt.Errorf("人物替换清晰度需为480p或720p")
	}
	if len([]rune(strings.TrimSpace(fmt.Sprint(n.Config["instructions"])))) > 2000 {
		return fmt.Errorf("补充要求不能超过2000字")
	}
	return nil
}
