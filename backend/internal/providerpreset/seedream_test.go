package providerpreset

import (
	"strings"
	"testing"
)

func TestSeedreamFamilyRecognizesDomesticPrefixAndModernModels(t *testing.T) {
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
		"":                                 "",
	} {
		if got := SeedreamFamily(model); got != want {
			t.Fatalf("SeedreamFamily(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestResolveSeedreamSizeFollowsOfficialPerModelLimits(t *testing.T) {
	// 火山方舟图片生成 API 的 size 规则：档位按型号族区分，自定义宽x高按总像素
	// 区间与 [1/16, 16] 宽高比判断。表里的反例来自模型文档本身。
	for _, item := range []struct {
		family  string
		size    string
		layers  bool
		want    string
		wantErr bool
	}{
		{family: "4.0", size: "1600x600", want: "1600x600"},
		{family: "4.5", size: "5504x3040", want: "5504x3040"},
		{family: "4.5", size: "1500x1500", wantErr: true},
		{family: "4.5", size: "1K", wantErr: true},
		{family: "pro", size: "4K", wantErr: true},
		{family: "pro", size: "1.5K", want: "1.5K"},
		{family: "lite", size: "3K", want: "3K"},
		{family: "4.0", size: "1K", want: "1K"},
		{family: "4.0", size: "16:9", want: "2560x1440"},
		{family: "pro", size: "16:9", layers: true, want: SeedreamDefaultTier},
		{family: "lite", size: "9:16", want: "1440x2560"},
		{family: "pro", size: "", want: SeedreamDefaultTier},
		{family: "pro", size: "1:1", want: SeedreamDefaultTier},
		{family: "pro", size: "auto", want: "auto"},
		{family: "pro", size: "1080p", wantErr: true},
		{family: "pro", size: "512x512", wantErr: true},
		{family: "4.0", size: "800x800", wantErr: true},
		{family: "4.0", size: "4096x200", wantErr: true},
	} {
		got, err := ResolveSeedreamSize(item.family, item.size, item.layers)
		if item.wantErr {
			if err == nil {
				t.Fatalf("%s %q should be rejected, got %q", item.family, item.size, got)
			}
			if !strings.Contains(err.Error(), "Seedream") || !strings.Contains(err.Error(), "图片尺寸") {
				t.Fatalf("%s %q error copy is not user actionable: %v", item.family, item.size, err)
			}
			continue
		}
		if err != nil || got != item.want {
			t.Fatalf("%s %q = %q, %v; want %q", item.family, item.size, got, err, item.want)
		}
	}
}

func TestResolveSeedreamSizeLeavesUnknownFamiliesAlone(t *testing.T) {
	// 自定义网关或没识别的型号不能被套上官方限制。
	if got, err := ResolveSeedreamSize("", "1600x600", false); err != nil || got != "1600x600" {
		t.Fatalf("unknown family = %q, %v", got, err)
	}
}
