package providerpreset

import (
	"fmt"
	"strconv"
	"strings"
)

// SeedreamFamily 识别 Seedream 型号族。国内渠道带 doubao- 前缀、国际渠道带 dola- 前缀，
// 官方 Pro / Flash 必须先于通用 5.0 匹配，否则国内 Pro / Flash 会被当成 Lite。
func SeedreamFamily(model string) string {
	normalized := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "doubao-")
	for _, item := range []struct{ prefix, family string }{
		{"dola-seedream-5-0-pro-", "pro"}, {"seedream-5-0-pro-", "pro"},
		{"dola-seedream-5-0-flash-", "flash"}, {"seedream-5-0-flash-", "flash"},
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

// seedreamAspectRatioSizes 把画布比例映射为官方 2K 参考像素值。
var seedreamAspectRatioSizes = map[string]string{
	"4:3":  "2304x1728",
	"3:4":  "1728x2304",
	"16:9": "2560x1440",
	"9:16": "1440x2560",
	"3:2":  "2496x1664",
	"2:3":  "1664x2496",
	"21:9": "3024x1296",
}

// 官方文档给出的自定义宽高总像素区间；宽高比区间统一为 [1/16, 16]。
const (
	seedreamMinPixelsStandard = 1280 * 720  // 921600
	seedreamMaxPixelsPro      = 4624220     // 2048x2048x1.1025
	seedreamMinPixelsLarge    = 2560 * 1440 // 3686400
	seedreamMaxPixelsLarge    = 4096 * 4096 // 16777216
)

// SeedreamSizeSpec 是官方文档给出的单型号 size 能力：可选分辨率档位，以及自定义宽高
// 同时受总像素数与宽高比约束。单边范围不能代替这两项限制。
type SeedreamSizeSpec struct {
	Label     string
	Tiers     []string
	MinPixels int64
	MaxPixels int64
	// AutoTier 表示官方文档为该型号记录了 auto（跟随原图）档位；目前只有 Pro / Flash 图层拆分场景。
	AutoTier bool
}

// SeedreamSizeSpecFor 返回型号族的 size 规则；未知型号族返回 false。
func SeedreamSizeSpecFor(family string) (SeedreamSizeSpec, bool) {
	switch family {
	case "pro", "flash":
		return SeedreamSizeSpec{Label: "Seedream 5.0 Pro / Flash", Tiers: []string{"1K", "1.5K", "2K"}, MinPixels: seedreamMinPixelsStandard, MaxPixels: seedreamMaxPixelsPro, AutoTier: true}, true
	case "lite":
		return SeedreamSizeSpec{Label: "Seedream 5.0 Lite", Tiers: []string{"2K", "3K", "4K"}, MinPixels: seedreamMinPixelsLarge, MaxPixels: seedreamMaxPixelsLarge}, true
	case "4.5":
		return SeedreamSizeSpec{Label: "Seedream 4.5", Tiers: []string{"2K", "4K"}, MinPixels: seedreamMinPixelsLarge, MaxPixels: seedreamMaxPixelsLarge}, true
	case "4.0":
		return SeedreamSizeSpec{Label: "Seedream 4.0", Tiers: []string{"1K", "2K", "4K"}, MinPixels: seedreamMinPixelsStandard, MaxPixels: seedreamMaxPixelsLarge}, true
	}
	return SeedreamSizeSpec{}, false
}

// SeedreamSize 把画布里的比例、档位或宽x高解析为该型号实际发送的 size。
// 比例先映射为最终像素值，再按型号校验档位、总像素与宽高比；预检与真实请求共用这一份规则。
func SeedreamSize(family, raw string, layers bool) (string, error) {
	spec, ok := SeedreamSizeSpecFor(family)
	if !ok {
		return strings.TrimSpace(raw), nil
	}
	size := strings.TrimSpace(raw)
	if size == "" || size == "1:1" {
		size = "2K"
	} else if mapped, isRatio := seedreamAspectRatioSizes[size]; isRatio {
		// 图层拆分只接受档位，比例一律回到默认档位。
		size = mapped
		if layers {
			size = "2K"
		}
	}
	size = strings.ReplaceAll(strings.ToUpper(size), "X", "x")
	if size == "AUTO" {
		size = "auto"
	}
	if err := spec.Validate(size); err != nil {
		return "", err
	}
	return size, nil
}

// Validate 校验一个已解析的 size 是否符合该型号的官方限制。
func (s SeedreamSizeSpec) Validate(size string) error {
	if size == "auto" {
		if s.AutoTier {
			return nil
		}
		return fmt.Errorf("%s 不支持 size=auto，可选值：%s", s.Label, strings.Join(s.Tiers, "、"))
	}
	for _, tier := range s.Tiers {
		if size == tier {
			return nil
		}
	}
	width, height, ok := parseSeedreamPixelSize(size)
	if !ok {
		return fmt.Errorf("%s 不支持 size=%s，可选值：%s，或宽x高像素尺寸（总像素 %d～%d）", s.Label, size, strings.Join(s.Tiers, "、"), s.MinPixels, s.MaxPixels)
	}
	pixels := int64(width) * int64(height)
	if pixels < s.MinPixels || pixels > s.MaxPixels {
		return fmt.Errorf("%s 的宽x高总像素须在 %d～%d 之间，%dx%d 为 %d", s.Label, s.MinPixels, s.MaxPixels, width, height, pixels)
	}
	if int64(width)*16 < int64(height) || int64(height)*16 < int64(width) {
		return fmt.Errorf("%s 的宽高比须在 1/16～16 之间，%dx%d 不满足", s.Label, width, height)
	}
	return nil
}

func parseSeedreamPixelSize(size string) (int, int, bool) {
	parts := strings.Split(size, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, widthErr := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, heightErr := strconv.Atoi(strings.TrimSpace(parts[1]))
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}
