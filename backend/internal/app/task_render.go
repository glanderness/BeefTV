package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

const renderFfmpegEnv = "CANVAS_FFMPEG_PATH"

// processTimelineRender 执行时间线渲染：按快照把引用的媒体落盘 →
// ffprobe 探测音轨 → ffmpeg concat 合成 → 产物写入资源存储。
// 渲染是本地重编码，不经模型路由；失败一律落明确终态。
func (w *taskWorkerCoordinator) processTimelineRender(task *model.Task, ctx context.Context) error {
	s := w.service
	ffmpegBin, err := renderFfmpegBinary()
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return w.failTimelineTask(task, "渲染失败", "任务缺少有效的时间线快照")
	}
	plan, err := editing.Compile(input.Timeline, nil, editing.DefaultOptions())
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}

	if err := w.progress(task, "准备媒体…", 10); err != nil {
		return err
	}
	workDir, files, cleanup, err := materializeRenderSources(ctx, s, task.UserID, plan)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	facts := map[string]editing.SourceFacts{}
	for sourceID, path := range files {
		fact, probeErr := probeMedia(ctx, path)
		if probeErr != nil {
			return w.failTimelineTask(task, "渲染失败", probeErr.Error())
		}
		facts[sourceID] = fact
	}
	if err := editing.ApplySourceFacts(plan, facts); err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}

	if plan.SubtitleSRT != "" {
		if err := os.WriteFile(filepath.Join(workDir, "render-subtitles.srt"), []byte(plan.SubtitleSRT), 0600); err != nil {
			return w.failTimelineTask(task, "渲染失败", "写入字幕文件失败")
		}
	}
	args := buildRenderFFmpegArgs(*plan, files, filepath.Join(workDir, "render-output.mp4"))
	if len(args) == 0 {
		return w.failTimelineTask(task, "渲染失败", "无法生成渲染命令")
	}
	if err := w.progress(task, "正在渲染…", 30); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	cmd.Dir = workDir
	output, runErr := cmd.CombinedOutput()
	if runErr != nil || (plan.SubtitleSRT != "" && renderSubtitleFontFailure(string(output))) {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 400 {
			detail = detail[len(detail)-400:]
		}
		return w.failTimelineTask(task, "渲染失败", fmt.Sprintf("ffmpeg 渲染失败：%s", detail))
	}

	if err := w.progress(task, "写入资源…", 85); err != nil {
		return err
	}
	renderedPath := filepath.Join(workDir, "render-output.mp4")
	file, err := os.Open(renderedPath)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "读取渲染产物失败")
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.Size() == 0 {
		return w.failTimelineTask(task, "渲染失败", "渲染产物为空")
	}
	durationMs := planDurationMs(*plan)
	fileName := fmt.Sprintf("timeline-render-%s.mp4", time.Now().Format("20060102-150405"))
	width, height := plan.Output.Width, plan.Output.Height
	if width <= 0 {
		width = editing.DefaultWidth
	}
	if height <= 0 {
		height = editing.DefaultHeight
	}
	resource, _, err := s.storeResource(task.UserID, "media", fileName, "video/mp4", stat.Size(), width, height, durationMs, file, nil, s.localResourceStorage)
	if err != nil || resource == nil {
		return w.failTimelineTask(task, "渲染失败", "保存渲染产物失败")
	}

	result := timelineRenderResult{
		ResourceID:  resource.ID,
		FileName:    fileName,
		Size:        stat.Size(),
		DurationMs:  durationMs,
		SubtitleSRT: plan.SubtitleSRT,
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "渲染结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "渲染完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入渲染完成态失败: %w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线渲染完成，时长 %.1fs", float64(durationMs)/1000), "")
	return nil
}

func planDurationMs(plan editing.Plan) int64 {
	return plan.DurationMs
}

func renderFfmpegBinary() (string, error) {
	if configured := strings.TrimSpace(os.Getenv(renderFfmpegEnv)); configured != "" {
		return configured, nil
	}
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", fmt.Errorf("渲染依赖未安装（需要 ffmpeg，可通过 %s 指定）", renderFfmpegEnv)
	}
	return path, nil
}

// materializeRenderSources 按计划中的不透明 sourceId 拉取已授权资源。
// 不信任任何客户端路径；同 id 复用同一份本地文件。
func materializeRenderSources(ctx context.Context, s *Service, userID string, plan *editing.Plan) (string, map[string]string, func(), error) {
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
		if s == nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		_, reader, err := s.OpenResource(userID, sourceID)
		if err != nil || reader == nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		path := filepath.Join(tmpDir, fmt.Sprintf("src-%d%s", len(files), extForMime("video/mp4")))
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
		file.Close()
		reader.Close()
		files[sourceID] = path
	}
	return tmpDir, files, cleanup, nil
}

func probeMedia(ctx context.Context, path string) (editing.SourceFacts, error) {
	bin, err := exec.LookPath("ffprobe")
	if err != nil {
		return editing.SourceFacts{}, fmt.Errorf("媒体探测依赖未安装（需要 ffprobe）")
	}
	cmd := exec.CommandContext(ctx, bin,
		"-v", "error", "-show_entries", "stream=codec_type:format=duration",
		"-of", "json", path)
	output, runErr := cmd.Output()
	if runErr != nil {
		return editing.SourceFacts{}, fmt.Errorf("媒体音轨探测失败: %w", runErr)
	}
	var parsed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return editing.SourceFacts{}, fmt.Errorf("无法解析素材：%w", err)
	}
	facts := editing.SourceFacts{}
	for _, stream := range parsed.Streams {
		switch stream.CodecType {
		case "audio":
			facts.HasAudio = true
		case "video":
			facts.HasVideo = true
		}
	}
	if seconds, convErr := parseProbeSeconds(parsed.Format.Duration); convErr == nil {
		facts.DurationMs = int64(seconds * 1000)
	}
	return facts, nil
}

func parseProbeSeconds(raw string) (float64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "N/A" {
		return 0, fmt.Errorf("missing duration")
	}
	var seconds float64
	_, err := fmt.Sscanf(raw, "%f", &seconds)
	if err != nil || seconds <= 0 {
		return 0, fmt.Errorf("invalid duration")
	}
	return seconds, nil
}

// libass can exit successfully even when no font can render the subtitle glyphs.
func renderSubtitleFontFailure(output string) bool {
	text := strings.ToLower(output)
	for _, failure := range []string{
		"failed to find any fallback", "no usable fontconfig", "fontselect: failed",
		"can't find selected font provider", "couldn't find font family",
		"failed to find font", "no fonts found", "missing glyph",
	} {
		if strings.Contains(text, failure) {
			return true
		}
	}
	// "Glyph ... not found, selecting one more font" is a normal fallback attempt.
	return false
}
