package providerpreset

import (
	"fmt"
	"strconv"
	"strings"
)

// SeedreamFamily 识别 Seedream 的型号族。国内官方型号带 doubao- 前缀，国际版和
// 网关型号不带；先去掉前缀再按族匹配，Pro / Flash 必须排在通用 5.0 之前，否则
// doubao-seedream-5-0-pro-* 会被当成 Lite。
func SeedreamFamily(model string) string {
	normalized := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "doubao-")
	for _, item := range []struct{ prefix, family string }{
		{"dola-seedream-5-0-pro-", "pro"},
		{"seedream-5-0-pro-", "pro"},
		{"dola-seedream-5-0-flash-", "flash"},
		{"seedream-5-0-flash-", "flash"},
		{"seedream-5-0-", "lite"},
		{"seedream-4-5-", "4.5"},
		{"seedream-4-0-", "4.0"},
	} {
		if strings.HasPrefix(normalized, item.prefix) {
			return item.family
		}
	}
	return ""
}

// SeedreamSizeRule 是一个型号族对 size 的官方限制，抄自火山方舟图片生成 API
// （https://docs.volcengine.com/docs/ark/image-generation-api，2026-10-27 核对）。
// 自定义宽x高按「总像素区间 + 宽高比」判断，不是按单边像素范围判断。
type SeedreamSizeRule struct {
	Tiers     []string
	MinPixels int64
	MaxPixels int64
}

const (
	seedreamMinRatio = 1.0 / 16
	seedreamMaxRatio = 16.0
	// SeedreamDefaultTier 是没填 size 或填 1:1 时使用、也是图层拆分唯一能用的档位。
	SeedreamDefaultTier = "2K"
)

var seedreamSizeRules = map[string]SeedreamSizeRule{
	// 5.0 pro / flash：1K、1.5K、2K；自定义总像素 [1280x720, 2048x2048x1.1025]。
	"pro":   {Tiers: []string{"1K", "1.5K", "2K"}, MinPixels: 921600, MaxPixels: 4624220},
	"flash": {Tiers: []string{"1K", "1.5K", "2K"}, MinPixels: 921600, MaxPixels: 4624220},
	// 5.0 lite：2K、3K、4K；自定义总像素 [2560x1440, 4096x4096]。
	"lite": {Tiers: []string{"2K", "3K", "4K"}, MinPixels: 3686400, MaxPixels: 16777216},
	// 4.5：2K、4K；自定义总像素 [2560x1440, 4096x4096]。
	"4.5": {Tiers: []string{"2K", "4K"}, MinPixels: 3686400, MaxPixels: 16777216},
	// 4.0：1K、2K、4K；自定义总像素 [1280x720, 4096x4096]。
	"4.0": {Tiers: []string{"1K", "2K", "4K"}, MinPixels: 921600, MaxPixels: 16777216},
}

// seedreamRatioSizes 把画布比例映射成官方 2K 档位的参考像素。2K 是每个型号族都
// 支持的档位，这些取值也都落在各族的总像素区间与 [1/16, 16] 宽高比内。
var seedreamRatioSizes = map[string]string{
	"4:3":  "2304x1728",
	"3:4":  "1728x2304",
	"16:9": "2560x1440",
	"9:16": "1440x2560",
	"3:2":  "2496x1664",
	"2:3":  "1664x2496",
	"21:9": "3024x1296",
}

func SeedreamSizeRuleFor(family string) (SeedreamSizeRule, bool) {
	rule, ok := seedreamSizeRules[family]
	return rule, ok
}

func SeedreamFamilyLabel(family string) string {
	switch family {
	case "pro":
		return "5.0 Pro"
	case "flash":
		return "5.0 Flash"
	case "lite":
		return "5.0 Lite"
	}
	return family
}

// ResolveSeedreamSize 把画布上的尺寸（比例、档位、宽x高或 auto）解析成发给上游的
// size，并拒绝该型号族不接受的取值。请求体与提交前的预检都用这一个函数，避免两边
// 判断不一致。
func ResolveSeedreamSize(family, raw string, layers bool) (string, error) {
	size := strings.TrimSpace(raw)
	if size == "" || size == "1:1" {
		size = SeedreamDefaultTier
	}
	if pixels, ok := seedreamRatioSizes[strings.ToLower(size)]; ok {
		// 图层拆分只能按档位出图，比例交给上游按原图保持。
		if layers {
			return SeedreamDefaultTier, nil
		}
		// 比例映射出来的像素仍按型号族规则复核，避免映射表改动后送出无效尺寸。
		if rule, known := SeedreamSizeRuleFor(family); known {
			width, height, _ := parseSeedreamPixelSize(pixels)
			if err := rule.validatePixels(width, height); err != nil {
				return "", fmt.Errorf("画布比例 %s 换算成 %s 后仍超出现有 Seedream %s 的限制：%s", size, pixels, SeedreamFamilyLabel(family), err.Error())
			}
		}
		return pixels, nil
	}
	if strings.EqualFold(size, "auto") {
		return "auto", nil
	}
	rule, ok := SeedreamSizeRuleFor(family)
	if !ok {
		// 没识别出型号族（含自定义网关）不套用官方限制。
		return size, nil
	}
	tier := strings.ToUpper(size)
	for _, allowed := range rule.Tiers {
		if tier == allowed {
			return tier, nil
		}
	}
	if isSeedreamTierName(tier) {
		return "", fmt.Errorf("图片尺寸 %s 不被 Seedream %s 支持；可选档位 %s，或总像素 %d～%d、宽高比 %s～%s 的宽x高", size, SeedreamFamilyLabel(family), strings.Join(rule.Tiers, "、"), rule.MinPixels, rule.MaxPixels, ratioText(seedreamMinRatio), ratioText(seedreamMaxRatio))
	}
	width, height, ok := parseSeedreamPixelSize(size)
	if !ok {
		return "", fmt.Errorf("图片尺寸 %s 不是 Seedream %s 支持的写法；请填档位（%s）、画布比例（16:9、9:16 等）或宽x高", size, SeedreamFamilyLabel(family), strings.Join(rule.Tiers, "、"))
	}
	if err := rule.validatePixels(width, height); err != nil {
		return "", fmt.Errorf("图片尺寸 %s 不被 Seedream %s 支持：%s", size, SeedreamFamilyLabel(family), err.Error())
	}
	return fmt.Sprintf("%dx%d", width, height), nil
}

func (r SeedreamSizeRule) validatePixels(width, height int) error {
	if width <= 0 || height <= 0 {
		return fmt.Errorf("宽和高必须是正整数")
	}
	ratio := float64(width) / float64(height)
	if ratio < seedreamMinRatio || ratio > seedreamMaxRatio {
		return fmt.Errorf("宽高比 %s 超出 %s～%s", strconv.FormatFloat(ratio, 'f', 3, 64), ratioText(seedreamMinRatio), ratioText(seedreamMaxRatio))
	}
	pixels := int64(width) * int64(height)
	if pixels < r.MinPixels || pixels > r.MaxPixels {
		return fmt.Errorf("总像素 %d 超出 %d～%d", pixels, r.MinPixels, r.MaxPixels)
	}
	return nil
}

func isSeedreamTierName(value string) bool {
	switch value {
	case "1K", "1.5K", "2K", "3K", "4K":
		return true
	}
	return false
}

func parseSeedreamPixelSize(raw string) (int, int, bool) {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(raw), "×", "x"), "X", "x"))
	parts := strings.Split(normalized, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, widthErr := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, heightErr := strconv.Atoi(strings.TrimSpace(parts[1]))
	if widthErr != nil || heightErr != nil {
		return 0, 0, false
	}
	return width, height, true
}

func ratioText(value float64) string {
	if value < 1 {
		return "1/" + strconv.FormatFloat(1/value, 'f', -1, 64)
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}
