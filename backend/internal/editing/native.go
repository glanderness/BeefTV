package editing

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const (
	FFmpegPathEnv    = "CANVAS_FFMPEG_PATH"
	SubtitleFileName = "render-subtitles.srt"
)

// ResolveFFmpegBinary returns the native ffmpeg executable.
// A configured CANVAS_FFMPEG_PATH is used as-is so tests can inject a missing binary
// without LookPath succeeding on a different ffmpeg.
func ResolveFFmpegBinary() (string, error) {
	if configured := strings.TrimSpace(os.Getenv(FFmpegPathEnv)); configured != "" {
		return configured, nil
	}
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", fmt.Errorf("渲染依赖未安装（需要 ffmpeg，可通过 %s 指定）", FFmpegPathEnv)
	}
	return path, nil
}

// BuildFFmpegArgs lowers a compiled plan into one native ffmpeg filter_complex graph.
// files maps opaque source ids to paths relative to the command working directory
// (or absolute paths). Missing source files return nil so execution cannot succeed
// after dropping content. This function does not re-select or reorder plan clips.
func BuildFFmpegArgs(plan Plan, files map[string]string, target string) []string {
	if len(plan.Segments) == 0 {
		return nil
	}
	width, height, fps, rate := plan.Output.Width, plan.Output.Height, plan.Output.FPS, plan.Output.SampleRate
	if width <= 0 {
		width = DefaultWidth
	}
	if height <= 0 {
		height = DefaultHeight
	}
	if fps <= 0 {
		fps = DefaultFPS
	}
	if rate <= 0 {
		rate = DefaultSampleRate
	}
	args := []string{"-nostdin", "-y"}
	filters := []string{}
	labels := ""
	for i, seg := range plan.Segments {
		duration := float64(seg.DurationMs) / 1000
		seconds := fmt.Sprintf("%.3f", duration)
		path := files[seg.SourceID]
		if seg.Kind != KindGap && path == "" {
			return nil
		}
		switch seg.Kind {
		case KindGap:
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d", width, height, fps))
		case KindImage:
			args = append(args, "-loop", "1", "-t", seconds, "-i", path)
		default:
			args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.SourceStartMs)/1000), "-t", seconds, "-i", path)
		}
		if seg.Kind == KindVideo && seg.HasAudio && !seg.Muted {
			args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.SourceStartMs)/1000), "-t", seconds, "-i", path)
		} else {
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("anullsrc=r=%d:cl=stereo", rate))
		}
		volume := seg.Volume
		filters = append(filters, fmt.Sprintf("[%d:v]setpts=PTS-STARTPTS,fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=%.3f,trim=duration=%.3f[v%d]", 2*i, fps, width, height, width, height, duration, duration, i))
		filters = append(filters, fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=%.3f,apad,atrim=duration=%.3f%s[a%d]", 2*i+1, rate, volume, duration, audioFades(seg.FadeInMs, seg.FadeOutMs, seg.DurationMs), i))
		labels += fmt.Sprintf("[v%d][a%d]", i, i)
	}
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=1[vbase][abase]", labels, len(plan.Segments)))
	mix := "[abase]"
	for i, seg := range plan.Audio {
		path := files[seg.SourceID]
		if path == "" {
			return nil
		}
		args = append(args, "-ss", fmt.Sprintf("%.3f", float64(seg.SourceStartMs)/1000), "-t", fmt.Sprintf("%.3f", float64(seg.DurationMs)/1000), "-i", path)
		volume := seg.Volume
		if seg.Muted {
			volume = 0
		}
		filters = append(filters, fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=%.3f,apad,atrim=duration=%.3f%s,adelay=%d:all=1[extra%d]", 2*len(plan.Segments)+i, rate, volume, float64(seg.DurationMs)/1000, audioFades(seg.FadeInMs, seg.FadeOutMs, seg.DurationMs), seg.StartMs, i))
		mix += fmt.Sprintf("[extra%d]", i)
	}
	filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=first:normalize=0,atrim=duration=%.3f[aout]", mix, len(plan.Audio)+1, float64(plan.DurationMs)/1000))
	if plan.Output.BurnSubtitles && plan.SubtitleSRT != "" {
		// 固定相对文件名避免工作目录/字幕文本进入滤镜表达式。
		filters = append(filters, fmt.Sprintf("[vbase]subtitles=filename=%s[vout]", SubtitleFileName))
	} else {
		filters = append(filters, "[vbase]null[vout]")
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", fmt.Sprintf("%.3f", float64(plan.DurationMs)/1000), target)
	return args
}

func audioFades(fadeInMs, fadeOutMs, durationMs int64) string {
	filters := ""
	if duration := min(fadeInMs, durationMs); duration > 0 {
		filters += fmt.Sprintf(",afade=t=in:st=0:d=%.3f", float64(duration)/1000)
	}
	if duration := min(fadeOutMs, durationMs); duration > 0 {
		filters += fmt.Sprintf(",afade=t=out:st=%.3f:d=%.3f", float64(durationMs-duration)/1000, float64(duration)/1000)
	}
	return filters
}
