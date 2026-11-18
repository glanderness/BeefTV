package editing

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SubtitleOverlay describes one rasterized subtitle cue PNG and its active window.
type SubtitleOverlay struct {
	Path    string
	StartMs int64
	EndMs   int64
}

// EncodeOptions customizes BuildFFmpegArgsWithOptions for runtime encoder/filter capabilities.
type EncodeOptions struct {
	VideoCodecArgs    []string
	SubtitleOverlays  []SubtitleOverlay
	ProtocolWhitelist string
}

// RasterizeSubtitleOverlays renders subtitle cues into transparent PNG files inside workDir
// when the active FFmpeg runtime lacks libass's subtitles filter.
func RasterizeSubtitleOverlays(workDir string, plan Plan) ([]SubtitleOverlay, error) {
	cues := plan.Subtitles
	if len(cues) == 0 && strings.TrimSpace(plan.SubtitleSRT) != "" {
		parsed, err := parseSubtitleSRT(plan.SubtitleSRT)
		if err != nil {
			return nil, err
		}
		cues = parsed
	}
	if len(cues) == 0 {
		return nil, nil
	}
	width, height := plan.Output.Width, plan.Output.Height
	if width <= 0 {
		width = DefaultWidth
	}
	if height <= 0 {
		height = DefaultHeight
	}
	byText := map[string]string{}
	overlays := make([]SubtitleOverlay, 0, len(cues))
	for _, cue := range cues {
		text := strings.TrimSpace(cue.Text)
		if text == "" || cue.DurationMs <= 0 {
			continue
		}
		pngName, ok := byText[text]
		if !ok {
			img, err := rasterizeSubtitleFrame(text, width, height)
			if err != nil {
				return nil, err
			}
			pngName = fmt.Sprintf("subtitle-%d.png", len(byText))
			fullPath := filepath.Join(workDir, pngName)
			if err := writePNGFile(fullPath, img); err != nil {
				return nil, fmt.Errorf("写入字幕图层失败: %w", err)
			}
			byText[text] = pngName
		}
		overlays = append(overlays, SubtitleOverlay{
			Path:    pngName,
			StartMs: max(0, cue.StartMs),
			EndMs:   max(0, cue.StartMs) + cue.DurationMs,
		})
	}
	return overlays, nil
}

func writePNGFile(path string, img image.Image) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func parseSubtitleSRT(raw string) ([]Subtitle, error) {
	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	blocks := strings.Split(strings.TrimSpace(normalized), "\n\n")
	var out []Subtitle
	for _, block := range blocks {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) < 2 {
			continue
		}
		timeIdx := 0
		if !strings.Contains(lines[0], "-->") {
			timeIdx = 1
		}
		if timeIdx >= len(lines) || !strings.Contains(lines[timeIdx], "-->") {
			continue
		}
		parts := strings.SplitN(lines[timeIdx], "-->", 2)
		startMs, err1 := parseSRTTimestamp(parts[0])
		endMs, err2 := parseSRTTimestamp(parts[1])
		if err1 != nil || err2 != nil || endMs <= startMs {
			return nil, fmt.Errorf("字幕时间戳格式无效")
		}
		text := strings.TrimSpace(strings.Join(lines[timeIdx+1:], "\n"))
		if text == "" {
			continue
		}
		out = append(out, Subtitle{
			StartMs:    startMs,
			DurationMs: endMs - startMs,
			Text:       text,
		})
	}
	return out, nil
}

func parseSRTTimestamp(raw string) (int64, error) {
	s := strings.TrimSpace(strings.ReplaceAll(raw, ".", ","))
	comma := strings.SplitN(s, ",", 2)
	if len(comma) != 2 {
		return 0, fmt.Errorf("invalid timestamp")
	}
	hms := strings.Split(comma[0], ":")
	if len(hms) != 3 {
		return 0, fmt.Errorf("invalid hms")
	}
	h, err1 := strconv.ParseInt(hms[0], 10, 64)
	m, err2 := strconv.ParseInt(hms[1], 10, 64)
	sec, err3 := strconv.ParseInt(hms[2], 10, 64)
	msText := comma[1]
	if fields := strings.Fields(msText); len(fields) > 0 {
		msText = fields[0]
	}
	ms, err4 := strconv.ParseInt(msText, 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		return 0, fmt.Errorf("invalid number")
	}
	return h*3600000 + m*60000 + sec*1000 + ms, nil
}
