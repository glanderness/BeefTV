package modelcatalog

import "testing"

// 自定义视频服务（full-video）的默认能力必须与 web 端默认值一致：
// 2.5 一代放开到 30 秒，2.0 一代保守 15 秒（需求 #37 / #61 / #101）。
func TestDefaultFullVideoVideoCapability(t *testing.T) {
	cases := []struct {
		model      string
		wantMax    int
		wantImages int
		wantVideos int
	}{
		{"原生不卡人脸-全参2.5", 30, 30, 10},
		{"sd-native-full-2.5", 30, 30, 10},
		{"原生不卡人脸-全参2.0", 15, 9, 3},
		{"sd-native-full-2.0", 15, 9, 3},
	}
	for _, testCase := range cases {
		config := DefaultModelCapabilityConfigForModel("full-video", testCase.model)
		if config == nil || config.Video == nil {
			t.Fatalf("%s: 缺少视频能力默认值", testCase.model)
		}
		video := config.Video
		if video.Duration.Selection != "range" {
			t.Fatalf("%s: 时长选择方式 = %q, 期望 range", testCase.model, video.Duration.Selection)
		}
		if video.Duration.Min != 4 || video.Duration.Max != testCase.wantMax || video.Duration.Default != 5 {
			t.Fatalf("%s: 时长范围 = %d~%d 默认 %d, 期望 4~%d 默认 5", testCase.model, video.Duration.Min, video.Duration.Max, video.Duration.Default, testCase.wantMax)
		}
		if video.References.MaxImages != testCase.wantImages || video.References.MaxVideos != testCase.wantVideos {
			t.Fatalf("%s: 参考素材 = 图 %d 视频 %d, 期望 图 %d 视频 %d", testCase.model, video.References.MaxImages, video.References.MaxVideos, testCase.wantImages, testCase.wantVideos)
		}
		if video.References.MaxVideoDuration != testCase.wantMax {
			t.Fatalf("%s: 参考视频时长上限 = %d, 期望 %d", testCase.model, video.References.MaxVideoDuration, testCase.wantMax)
		}
		if !containsCapabilityString(video.Operations, "reference_to_video") {
			t.Fatalf("%s: 默认操作缺少 reference_to_video", testCase.model)
		}
	}
}

// 后端按默认能力校验时，2.5 模型请求 30 秒必须通过（此前默认 15 秒会直接拒单）。
func TestNormalizeFullVideoAllowsThirtySeconds(t *testing.T) {
	input := &ModelCapabilityConfig{Version: 1, Video: &VideoCapabilityConfig{
		References:        VideoReferenceConfig{PromptMaxChars: 4000},
		Duration:          VideoDurationConfig{Selection: "range", Min: 4, Max: 30, Step: 1, Default: 30},
		Ratios:            []string{"16:9"},
		DefaultRatio:      "16:9",
		Resolutions:       []string{"720p"},
		DefaultResolution: "720p",
		Operations:        []string{"text_to_video"},
		DefaultOperation:  "text_to_video",
	}}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "full-video", "原生不卡人脸-全参2.5", input)
	if err != nil {
		t.Fatalf("30 秒配置被拒绝: %v", err)
	}
	if normalized == nil || normalized.Video == nil {
		t.Fatal("归一化结果为空")
	}
	if normalized.Video.Duration.Max != 30 || normalized.Video.Duration.Default != 30 {
		t.Fatalf("时长上限被夹到 %d（默认 %d），期望保留 30", normalized.Video.Duration.Max, normalized.Video.Duration.Default)
	}
}

func TestIsFullVideoSeedance25(t *testing.T) {
	cases := map[string]bool{
		"原生不卡人脸-全参2.5":             true,
		"sd-native-full-2.5":       true,
		"sd-native-full-2.5 ":      true,
		"SD-NATIVE-FULL-2.5":       true,
		"proxy/sd-native-full-2.5": true,
		"原生不卡人脸-全参2.0":             false,
		"sd-native-full-2.0":       false,
		"":                         false,
	}
	for model, want := range cases {
		if got := isFullVideoSeedance25(model); got != want {
			t.Fatalf("isFullVideoSeedance25(%q) = %v, 期望 %v", model, got, want)
		}
	}
}

// 渠道建好后能力参数是存下来的快照，旧版把上限写死 15 秒；
// 归一化时 2.5 一代要按代际抬到 30 秒，其他代际和用户自定的上限保持不动（需求 #37 / #61 / #101）。
func TestUpgradeLegacySeedance25DurationCeiling(t *testing.T) {
	saved := func(max int) *ModelCapabilityConfig {
		return &ModelCapabilityConfig{Version: 1, Video: &VideoCapabilityConfig{
			References:        VideoReferenceConfig{PromptMaxChars: 4000},
			Duration:          VideoDurationConfig{Selection: "range", Min: 4, Max: max, Step: 1, Default: 5},
			Ratios:            []string{"16:9"},
			DefaultRatio:      "16:9",
			Resolutions:       []string{"720p"},
			DefaultResolution: "720p",
			Operations:        []string{"text_to_video"},
			DefaultOperation:  "text_to_video",
		}}
	}
	cases := []struct {
		model string
		saved int
		want  int
	}{
		{"sd-native-full-2.5", 15, 30},
		{"原生不卡人脸-全参2.5", 15, 30},
		{"sd-native-full-2.0", 15, 15},
		{"sd-native-full-2.5", 20, 20},
	}
	for _, testCase := range cases {
		normalized, err := NormalizeModelCapabilityConfigForModel("video", "full-video", testCase.model, saved(testCase.saved))
		if err != nil {
			t.Fatalf("%s: 旧配置归一化失败: %v", testCase.model, err)
		}
		if normalized == nil || normalized.Video == nil {
			t.Fatalf("%s: 归一化结果为空", testCase.model)
		}
		if got := normalized.Video.Duration.Max; got != testCase.want {
			t.Fatalf("%s: 存下来的上限 %d 归一化后是 %d, 期望 %d", testCase.model, testCase.saved, got, testCase.want)
		}
	}
}
