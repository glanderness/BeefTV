package providerpreset

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	mjRatioFlag       = regexp.MustCompile(`(?i)(?:^|\s)(?:--|\x{2014})(?:ar|aspect)\b(?:\s+([^\s]+)|=([^\s]+))?`)
	mjHDFlag          = regexp.MustCompile(`(?i)(?:^|\s)(?:--|\x{2014})hd(?:\s|$)`)
	mjHDAssignFlag    = regexp.MustCompile(`(?i)(?:^|\s)(?:--|\x{2014})hd=`)
	mjUnsupportedFlag = regexp.MustCompile(`(?i)(?:^|\s)(?:--|\x{2014})(?:turbo|fast|relax|repeat|r|v|version|niji)(?:\s|=|$)`)
)

// The priced gateway model supports 1K/2K (--hd), 8 aspect ratios (incl. 21:9),
// and safe native prompt suffixes (--q/--quality/--draft/--raw/--s/--c/--sref/--p/--no).
// Explicit --ar / --hd in the prompt take precedence over UI defaults.
func (c ImageContract) GenerationPrompt(prompt, size string) (string, error) {
	if c.Model != "midjourney-v8.2" || len(c.Presets) == 0 {
		return prompt, nil
	}
	pixels, err := c.PixelSize(size)
	if err != nil {
		return "", err
	}
	var selected ImagePreset
	for _, preset := range c.Presets {
		if preset.Size == pixels {
			selected = preset
			break
		}
	}
	if selected.Size == "" {
		return "", fmt.Errorf("当前 Midjourney 不支持所选尺寸")
	}
	if mjUnsupportedFlag.MatchString(prompt) {
		return "", fmt.Errorf("当前官方 Midjourney 渠道不支持速度、版本或重复参数，请清理后重试")
	}
	if mjHDAssignFlag.MatchString(prompt) {
		return "", fmt.Errorf("Midjourney --hd 不接受参数值，请直接写 --hd")
	}
	arMatches := mjRatioFlag.FindAllStringSubmatch(prompt, -1)
	hasPromptAR := len(arMatches) > 0
	hasPromptHD := mjHDFlag.MatchString(prompt)
	subjectOnly := strings.TrimSpace(mjHDFlag.ReplaceAllString(mjRatioFlag.ReplaceAllString(prompt, " "), " "))
	if subjectOnly == "" {
		return "", fmt.Errorf("请输入图片内容描述")
	}
	out := strings.TrimSpace(prompt)
	if !hasPromptAR && selected.Ratio != "1:1" {
		out += " --ar " + selected.Ratio
	}
	if strings.EqualFold(selected.Tier, "2k") && !hasPromptHD {
		out += " --hd"
	}
	return out, nil
}
