package providerpreset

import "testing"

func TestSeedreamFamilyRecognizesDomesticAndInternationalModels(t *testing.T) {
	for model, want := range map[string]string{
		"doubao-seedream-5-0-pro-260628":   "pro",
		"doubao-seedream-5-0-flash-260915": "flash",
		"doubao-seedream-5-0-260128":       "lite",
		"doubao-seedream-4-5-251128":       "4.5",
		"doubao-seedream-4-0-250828":       "4.0",
		"dola-seedream-5-0-pro-260628":     "pro",
		"dola-seedream-5-0-flash-260915":   "flash",
		"seedream-5-0-pro-260628":          "pro",
		"seedream-5-0-flash-260915":        "flash",
		"seedream-5-0-260128":              "lite",
		"seedream-4-5-251128":              "4.5",
		"seedream-4-0-250828":              "4.0",
		"gpt-image-2":                      "",
		"doubao-seedream-test":             "",
	} {
		if got := SeedreamFamily(model); got != want {
			t.Fatalf("SeedreamFamily(%q)=%q, want %q", model, got, want)
		}
	}
}

func TestSeedreamSizeFollowsModelPixelAndRatioLimits(t *testing.T) {
	for _, test := range []struct {
		family, size string
		layers       bool
		want         string
		rejected     bool
	}{
		// 官方文档示例：单边范围不能代替总像素与宽高比限制。
		{"4.0", "1600x600", false, "1600x600", false},
		{"4.0", "800x800", false, "", true},
		{"4.5", "3750x1250", false, "3750x1250", false},
		{"4.5", "5504x3040", false, "5504x3040", false},
		{"4.5", "1500x1500", false, "", true},
		{"lite", "3750x1250", false, "3750x1250", false},
		{"pro", "2048x1024", false, "2048x1024", false},
		{"pro", "512x512", false, "", true},
		{"pro", "6000x1000", false, "", true},
		// 档位按型号族区分。
		{"pro", "1.5K", false, "1.5K", false},
		{"pro", "4K", false, "", true},
		{"flash", "2K", false, "2K", false},
		{"4.5", "1K", false, "", true},
		{"4.5", "4K", false, "4K", false},
		{"lite", "4K", false, "4K", false},
		{"lite", "1K", false, "", true},
		{"4.0", "1K", false, "1K", false},
		{"4.0", "1.5K", false, "", true},
		// 画布比例先映射为像素值再校验。
		{"pro", "16:9", false, "2560x1440", false},
		{"4.5", "21:9", false, "3024x1296", false},
		{"4.0", "1:1", false, "2K", false},
		{"pro", "16:9", true, "2K", false},
		{"4.5", "", false, "2K", false},
		{"lite", "2k", false, "2K", false},
		{"pro", "1080p", false, "", true},
		// auto 只有 Pro / Flash 有官方记录（图层拆分场景）。
		{"pro", "auto", true, "auto", false},
		{"flash", "AUTO", true, "auto", false},
		{"4.5", "auto", false, "", true},
		{"lite", "auto", false, "", true},
	} {
		got, err := SeedreamSize(test.family, test.size, test.layers)
		if test.rejected {
			if err == nil {
				t.Fatalf("%s size=%q layers=%v should be rejected, got %q", test.family, test.size, test.layers, got)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s size=%q layers=%v: %v", test.family, test.size, test.layers, err)
		}
		if got != test.want {
			t.Fatalf("%s size=%q layers=%v = %q, want %q", test.family, test.size, test.layers, got, test.want)
		}
	}
}

func TestSeedreamSizeKeepsUnknownFamilyValue(t *testing.T) {
	if got, err := SeedreamSize("", "16:9", false); err != nil || got != "16:9" {
		t.Fatalf("unknown family must not be validated: %q %v", got, err)
	}
}
