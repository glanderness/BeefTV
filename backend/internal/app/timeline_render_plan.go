package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// 时间线渲染：把前端 TimelineProject 快照（tracks/clips 平铺，见
// web/src/types/timeline.ts TimelineProject v2）展开为可执行的 ffmpeg 步骤。
// 与前端 timeline-to-ffmpeg.ts 保持同一数据流：trim（按 sourceStartMs 裁切）
// → 空隙补黑场静音 → concat → 混合独立音轨 → 烧录字幕（需要 libass）。
//
// 输入布局统一为「每个片段两个输入：视频源 + 音频源」，空隙展开为独立
// 黑场片段，因此第 i 个片段的视频输入为 2i、音频输入为 2i+1。

type renderClip struct {
	ID               string  `json:"id"`
	Kind             string  `json:"kind"`
	TrackID          string  `json:"trackId"`
	StartMs          int64   `json:"startMs"`
	DurationMs       int64   `json:"durationMs"`
	SourceStartMs    int64   `json:"sourceStartMs"`
	SourceDurationMs int64   `json:"sourceDurationMs"`
	Volume           float64 `json:"volume"`
	FadeInMs         int64   `json:"fadeInMs"`
	FadeOutMs        int64   `json:"fadeOutMs"`
	Text             string  `json:"text"`
	DirectMedia      *struct {
		ID         string `json:"id"`
		Kind       string `json:"kind"`
		StorageKey string `json:"storageKey"`
	} `json:"directMedia"`
}

// volume 缺省为 1；显式的 0 必须保留为静音。
func (clip *renderClip) UnmarshalJSON(data []byte) error {
	type plain renderClip
	value := plain{Volume: 1}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*clip = renderClip(value)
	return nil
}

type renderTrack struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Visible *bool  `json:"visible"`
	Muted   bool   `json:"muted"`
}

type renderProject struct {
	Version    int           `json:"version"`
	Tracks     []renderTrack `json:"tracks"`
	Clips      []renderClip  `json:"clips"`
	DurationMs int64         `json:"durationMs"`
}

type renderSource struct {
	ResourceID string
	Clip       renderClip
	Path       string
	Ext        string
	// HasAudio 由 ffprobe 探测得到；无音轨的媒体改为静音源，避免 map 失败。
	HasAudio bool
}

// renderSegment 是渲染序列中的一段；Kind 为 video/image 表示媒体片段，
// gap 表示补黑场静音的空隙段（无 Source）。
type renderSegment struct {
	Kind       string
	DurationMs int64
	GapMs      int64
	Clip       renderClip
	Muted      bool
	Source     *renderSource
}

type renderPlan struct {
	Segments    []renderSegment
	Audio       []renderSegment
	Error       error
	SubtitleSRT string
	HasMedia    bool
}

// buildRenderPlan 挑选可见视频/图片轨片段按 startMs 排序，并把片段之间的
// 空隙展开为黑场段，使渲染序列在时间轴上连续。
func buildRenderPlan(project renderProject) renderPlan {
	visible := map[string]bool{}
	muted := map[string]bool{}
	for _, track := range project.Tracks {
		visible[track.ID] = track.Visible == nil || *track.Visible
		muted[track.ID] = track.Muted
	}
	plan := renderPlan{SubtitleSRT: buildRenderSubtitleSRT(project)}
	end := project.DurationMs
	clips := make([]renderClip, 0, len(project.Clips))
	for _, clip := range project.Clips {
		if !visible[clip.TrackID] {
			continue
		}
		if clip.StartMs < 0 || clip.SourceStartMs < 0 {
			plan.Error = fmt.Errorf("片段时间不能为负数")
			return plan
		}
		if clip.DurationMs > 0 && clip.StartMs+clip.DurationMs > end {
			end = clip.StartMs + clip.DurationMs
		}
		if clip.Kind == "audio" && clip.DurationMs > 0 {
			plan.Audio = append(plan.Audio, renderSegment{Kind: "audio", Clip: clip, DurationMs: clip.DurationMs, Muted: muted[clip.TrackID]})
			plan.HasMedia = true
			continue
		}
		if clip.Kind != "video" && clip.Kind != "image" {
			continue
		}
		if clip.DurationMs <= 0 {
			continue
		}
		clips = append(clips, clip)
	}
	sort.SliceStable(clips, func(i, j int) bool {
		if clips[i].StartMs == clips[j].StartMs {
			return clips[i].ID < clips[j].ID
		}
		return clips[i].StartMs < clips[j].StartMs
	})

	cursor := int64(0)
	for _, clip := range clips {
		if clip.StartMs < cursor {
			plan.Error = fmt.Errorf("服务端渲染暂不支持重叠的视频或图片片段")
			return plan
		}
		if gap := clip.StartMs - cursor; gap > 0 {
			plan.Segments = append(plan.Segments, renderSegment{Kind: "gap", DurationMs: gap, GapMs: gap})
		}
		plan.Segments = append(plan.Segments, renderSegment{Kind: clip.Kind, DurationMs: clip.DurationMs, Clip: clip, Muted: muted[clip.TrackID]})
		cursor = clip.StartMs + clip.DurationMs
	}
	if end > cursor {
		plan.Segments = append(plan.Segments, renderSegment{Kind: "gap", DurationMs: end - cursor})
	}
	if len(clips) > 0 {
		plan.HasMedia = true
	}
	return plan
}

// mediaResourceID 从片段的 directMedia.storageKey（resource:<id>）还原资源 ID。
func mediaResourceID(clip renderClip) (string, bool) {
	if clip.DirectMedia == nil {
		return "", false
	}
	key := strings.TrimSpace(clip.DirectMedia.StorageKey)
	if !strings.HasPrefix(key, "resource:") {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(key, "resource:"))
	return id, id != ""
}

func buildRenderSubtitleSRT(project renderProject) string {
	visible := map[string]bool{}
	for _, track := range project.Tracks {
		visible[track.ID] = track.Visible == nil || *track.Visible
	}
	subtitle := make([]renderClip, 0, len(project.Clips))
	for _, clip := range project.Clips {
		if len(project.Tracks) > 0 && !visible[clip.TrackID] {
			continue
		}
		if clip.Kind != "subtitle" || strings.TrimSpace(clip.Text) == "" || clip.DurationMs <= 0 {
			continue
		}
		subtitle = append(subtitle, clip)
	}
	sort.SliceStable(subtitle, func(i, j int) bool {
		if subtitle[i].StartMs == subtitle[j].StartMs {
			return subtitle[i].ID < subtitle[j].ID
		}
		return subtitle[i].StartMs < subtitle[j].StartMs
	})
	if len(subtitle) == 0 {
		return ""
	}
	var out strings.Builder
	for i, clip := range subtitle {
		fmt.Fprintf(&out, "%d\n%s --> %s\n%s\n\n",
			i+1,
			formatSRTTimestamp(clip.StartMs),
			formatSRTTimestamp(clip.StartMs+clip.DurationMs),
			strings.TrimSpace(clip.Text))
	}
	return out.String()
}

const (
	renderWidth      = 1920
	renderHeight     = 1080
	renderFPS        = 30
	renderSampleRate = 44100
)

// buildRenderFFmpegArgs 依据渲染计划生成 ffmpeg 参数（工作目录内相对路径）。
// 每段固定两个输入：视频源与音频源，末尾 concat 为单路输出。
func buildRenderFFmpegArgs(plan renderPlan, target string) []string {
	if len(plan.Segments) == 0 || plan.Error != nil {
		return nil
	}
	args := []string{"-nostdin", "-y"}
	filters := []string{}
	labels := ""
	for i, seg := range plan.Segments {
		duration := float64(seg.DurationMs) / 1000
		seconds := fmt.Sprintf("%.3f", duration)
		if seg.Kind != "gap" && (seg.Source == nil || seg.Source.Path == "") {
			return nil
		}
		switch seg.Kind {
		case "gap":
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d", renderWidth, renderHeight, renderFPS))
		case "image":
			args = append(args, "-loop", "1", "-t", seconds, "-i", seg.Source.Path)
		default:
			args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.Clip.SourceStartMs)/1000), "-t", seconds, "-i", seg.Source.Path)
		}
		if seg.Kind == "video" && seg.Source.HasAudio && !seg.Muted {
			args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.Clip.SourceStartMs)/1000), "-t", seconds, "-i", seg.Source.Path)
		} else {
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", renderSampleRate))
		}
		filters = append(filters, fmt.Sprintf("[%d:v]setpts=PTS-STARTPTS,fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=%.3f,trim=duration=%.3f[v%d]", 2*i, renderFPS, renderWidth, renderHeight, renderWidth, renderHeight, duration, duration, i))
		filters = append(filters, fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=%.3f,apad,atrim=duration=%.3f%s[a%d]", 2*i+1, renderSampleRate, seg.Clip.Volume, duration, renderAudioFades(seg.Clip), i))
		labels += fmt.Sprintf("[v%d][a%d]", i, i)
	}
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=1[vbase][abase]", labels, len(plan.Segments)))
	mix := "[abase]"
	for i, seg := range plan.Audio {
		if seg.Source == nil || seg.Source.Path == "" || !seg.Source.HasAudio {
			return nil
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.Clip.SourceStartMs)/1000), "-t", fmt.Sprintf("%.3f", float64(seg.DurationMs)/1000), "-i", seg.Source.Path)
		volume := seg.Clip.Volume
		if seg.Muted {
			volume = 0
		}
		filters = append(filters, fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=%.3f,apad,atrim=duration=%.3f%s,adelay=%d:all=1[extra%d]", 2*len(plan.Segments)+i, renderSampleRate, volume, float64(seg.DurationMs)/1000, renderAudioFades(seg.Clip), seg.Clip.StartMs, i))
		mix += fmt.Sprintf("[extra%d]", i)
	}
	filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=first:normalize=0,atrim=duration=%.3f[aout]", mix, len(plan.Audio)+1, planTotalSeconds(plan)))
	if plan.SubtitleSRT != "" {
		// 固定相对文件名避免工作目录/字幕文本进入滤镜表达式。
		filters = append(filters, "[vbase]subtitles=filename=render-subtitles.srt[vout]")
	} else {
		filters = append(filters, "[vbase]null[vout]")
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", fmt.Sprintf("%.3f", planTotalSeconds(plan)), target)
	return args
}

func planTotalSeconds(plan renderPlan) float64 {
	var total int64
	for _, seg := range plan.Segments {
		total += seg.DurationMs
	}
	return float64(total) / 1000
}

func renderAudioFades(clip renderClip) string {
	filters := ""
	if duration := min(clip.FadeInMs, clip.DurationMs); duration > 0 {
		filters += fmt.Sprintf(",afade=t=in:st=0:d=%.3f", float64(duration)/1000)
	}
	if duration := min(clip.FadeOutMs, clip.DurationMs); duration > 0 {
		filters += fmt.Sprintf(",afade=t=out:st=%.3f:d=%.3f", float64(clip.DurationMs-duration)/1000, float64(duration)/1000)
	}
	return filters
}
