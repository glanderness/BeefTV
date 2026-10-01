package editing

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const renderOutputName = "render-output.mp4"

// Renderer executes a compiled semantic plan with native ffmpeg.
// It materializes opaque sources, probes tracks, lowers the plan, and writes
// one bounded MP4. It does not compile a second plan or persist workspace resources.
type Renderer struct {
	Sources SourceOpener
	FFmpeg  string
}

// RenderedOutput is the local encode result before workspace resource composition.
type RenderedOutput struct {
	Path        string
	Size        int64
	Width       int
	Height      int
	DurationMs  int64
	SubtitleSRT string
}

func (r *Renderer) ffmpegBinary() (string, error) {
	if r != nil && strings.TrimSpace(r.FFmpeg) != "" {
		return r.FFmpeg, nil
	}
	return ResolveFFmpegBinary()
}

func reportProgress(progress Progress, stage string, percent int) error {
	if progress == nil {
		return nil
	}
	return progress(stage, percent)
}

// Render materializes sources, binds probe facts, and encodes the plan.
// On success the caller must invoke cleanup after consuming Path.
// On failure cleanup has already run.
func (r *Renderer) Render(ctx context.Context, plan *Plan, progress Progress) (RenderedOutput, func(), error) {
	if plan == nil || !plan.HasMedia() {
		return RenderedOutput{}, nil, ErrNoMedia
	}
	ffmpegBin, err := r.ffmpegBinary()
	if err != nil {
		return RenderedOutput{}, nil, err
	}
	if err := reportProgress(progress, "准备媒体…", 10); err != nil {
		return RenderedOutput{}, nil, err
	}
	workDir, files, cleanup, err := r.materialize(ctx, plan)
	if err != nil {
		return RenderedOutput{}, nil, err
	}
	fail := func(err error) (RenderedOutput, func(), error) {
		if cleanup != nil {
			cleanup()
		}
		return RenderedOutput{}, nil, err
	}
	facts := map[string]SourceFacts{}
	for sourceID, path := range files {
		fact, probeErr := Probe(ctx, path)
		if probeErr != nil {
			return fail(probeErr)
		}
		facts[sourceID] = fact
	}
	if err := ApplySourceFacts(plan, facts); err != nil {
		return fail(err)
	}
	if plan.SubtitleSRT != "" {
		if err := os.WriteFile(filepath.Join(workDir, SubtitleFileName), []byte(plan.SubtitleSRT), 0600); err != nil {
			return fail(fmt.Errorf("写入字幕文件失败"))
		}
	}
	target := filepath.Join(workDir, renderOutputName)
	args := BuildFFmpegArgs(*plan, files, target)
	if len(args) == 0 {
		return fail(fmt.Errorf("无法生成渲染命令"))
	}
	if err := reportProgress(progress, "正在渲染…", 30); err != nil {
		return fail(err)
	}
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	cmd.Dir = workDir
	output, runErr := cmd.CombinedOutput()
	if runErr != nil || (plan.SubtitleSRT != "" && SubtitleFontFailure(string(output))) {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 400 {
			detail = detail[len(detail)-400:]
		}
		return fail(fmt.Errorf("ffmpeg 渲染失败：%s", detail))
	}
	stat, err := os.Stat(target)
	if err != nil {
		return fail(fmt.Errorf("读取渲染产物失败"))
	}
	if stat.Size() == 0 {
		return fail(fmt.Errorf("渲染产物为空"))
	}
	width, height := plan.Output.Width, plan.Output.Height
	if width <= 0 {
		width = DefaultWidth
	}
	if height <= 0 {
		height = DefaultHeight
	}
	return RenderedOutput{
		Path:        target,
		Size:        stat.Size(),
		Width:       width,
		Height:      height,
		DurationMs:  plan.DurationMs,
		SubtitleSRT: plan.SubtitleSRT,
	}, cleanup, nil
}

func (r *Renderer) materialize(ctx context.Context, plan *Plan) (string, map[string]string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "beeftv-render-*")
	if err != nil {
		return "", nil, nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	files := map[string]string{}
	for _, sourceID := range plan.SourceIDs() {
		if err := ctx.Err(); err != nil {
			cleanup()
			return "", nil, nil, err
		}
		if sourceID == "" {
			cleanup()
			return "", nil, nil, fmt.Errorf("片段缺少有效媒体引用")
		}
		if r == nil || r.Sources == nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		reader, err := r.Sources.Open(ctx, sourceID)
		if err != nil || reader == nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		path := filepath.Join(tmpDir, fmt.Sprintf("src-%d.mp4", len(files)))
		file, err := os.Create(path)
		if err != nil {
			reader.Close()
			cleanup()
			return "", nil, nil, fmt.Errorf("写入临时媒体失败: %w", err)
		}
		if _, err := io.Copy(file, reader); err != nil {
			file.Close()
			reader.Close()
			cleanup()
			return "", nil, nil, fmt.Errorf("读取时间线媒体失败: %w", err)
		}
		if err := file.Close(); err != nil {
			reader.Close()
			cleanup()
			return "", nil, nil, fmt.Errorf("写入临时媒体失败: %w", err)
		}
		if err := reader.Close(); err != nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("读取时间线媒体失败: %w", err)
		}
		files[sourceID] = path
	}
	return tmpDir, files, cleanup, nil
}
