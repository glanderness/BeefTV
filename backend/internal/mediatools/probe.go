package mediatools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type MediaMetadata struct {
	FormatName         string
	Width, Height      int
	Rotation           int
	DurationMs         int64
	VideoDurationMs    int64
	FPS                float64
	VideoFrames        int64
	PixelAspectRatio   float64
	VideoCodec         string
	AudioCodec         string
	HasAudio, HasVideo bool
}

func (m MediaMetadata) DisplayDimensions() (int, int) {
	par := m.PixelAspectRatio
	if par <= 0 {
		par = 1
	}
	w := int(math.Ceil(float64(m.Width) * par))
	h := m.Height
	rot := m.Rotation % 360
	if rot < 0 {
		rot += 360
	}
	if rot == 90 || rot == 270 {
		return h, w
	}
	return w, h
}

// ProbeLocal only accepts an existing local regular file. Protocol restrictions
// prevent a playlist or container from making network requests during probing.
func ProbeLocal(ctx context.Context, path string) (MediaMetadata, error) {
	var facts MediaMetadata
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return facts, fmt.Errorf("媒体文件无法读取")
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return facts, err
	}
	bin, err := ResolveFFprobe()
	if err != nil {
		return facts, err
	}
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-protocol_whitelist", "file,pipe",
		"-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,sample_aspect_ratio,duration:stream_tags=rotate:stream_side_data=rotation:format=duration,format_name", "-of", "json", path)
	HideConsole(cmd)
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return facts, ctx.Err()
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
			return facts, fmt.Errorf("%w：视频处理工具不可用，请重新安装应用", ErrToolUnavailable)
		}
		return facts, fmt.Errorf("%w：无法检查媒体，请确认素材完整且格式受支持", ErrInvalidMedia)
	}
	var parsed struct {
		Streams []struct {
			CodecType     string `json:"codec_type"`
			CodecName     string `json:"codec_name"`
			Width, Height int
			FrameCount    string `json:"nb_frames"`
			PixelAspect   string `json:"sample_aspect_ratio"`
			AvgFrameRate  string `json:"avg_frame_rate"`
			Duration      string `json:"duration"`
			Tags          struct {
				Rotate string `json:"rotate"`
			} `json:"tags"`
			SideDataList []struct {
				Rotation float64 `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return facts, fmt.Errorf("%w：无法解析媒体检查结果", ErrMediaProcessFailed)
	}
	facts.DurationMs = probeDuration(parsed.Format.Duration)
	facts.FormatName = parsed.Format.FormatName
	for _, stream := range parsed.Streams {
		if stream.CodecType == "audio" {
			facts.HasAudio = true
			if facts.AudioCodec == "" {
				facts.AudioCodec = strings.ToLower(strings.TrimSpace(stream.CodecName))
			}
		}
		if stream.CodecType == "video" {
			facts.HasVideo = true
			if facts.VideoCodec == "" {
				facts.VideoCodec = strings.ToLower(strings.TrimSpace(stream.CodecName))
			}
			if facts.Width == 0 {
				facts.Width, facts.Height = stream.Width, stream.Height
				facts.VideoFrames, _ = strconv.ParseInt(stream.FrameCount, 10, 64)
				facts.PixelAspectRatio = probeFrameRate(strings.Replace(stream.PixelAspect, ":", "/", 1))
				if facts.PixelAspectRatio == 0 {
					facts.PixelAspectRatio = 1
				}
				for _, sd := range stream.SideDataList {
					if sd.Rotation != 0 && !math.IsNaN(sd.Rotation) && !math.IsInf(sd.Rotation, 0) {
						facts.Rotation = int(math.Round(sd.Rotation))
						break
					}
				}
				if facts.Rotation == 0 && strings.TrimSpace(stream.Tags.Rotate) != "" {
					if rot, rotErr := strconv.ParseFloat(strings.TrimSpace(stream.Tags.Rotate), 64); rotErr == nil && !math.IsNaN(rot) && !math.IsInf(rot, 0) {
						facts.Rotation = int(math.Round(rot))
					}
				}
			}
			if facts.FPS == 0 {
				facts.FPS = probeFrameRate(stream.AvgFrameRate)
			}
			if facts.VideoDurationMs == 0 {
				facts.VideoDurationMs = probeDuration(stream.Duration)
			}
		}
		if facts.DurationMs == 0 {
			facts.DurationMs = probeDuration(stream.Duration)
		}
	}
	return facts, nil
}

func probeFrameRate(raw string) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if numStr, denStr, ok := strings.Cut(raw, "/"); ok {
		num, err1 := strconv.ParseFloat(strings.TrimSpace(numStr), 64)
		den, err2 := strconv.ParseFloat(strings.TrimSpace(denStr), 64)
		if err1 != nil || err2 != nil || num <= 0 || den <= 0 {
			return 0
		}
		fps := num / den
		if math.IsNaN(fps) || math.IsInf(fps, 0) {
			return 0
		}
		return fps
	}
	fps, err := strconv.ParseFloat(raw, 64)
	if err != nil || fps <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) {
		return 0
	}
	return fps
}

func probeDuration(raw string) int64 {
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds >= float64(math.MaxInt64)/1000 {
		return 0
	}
	return int64(math.Round(seconds * 1000))
}
