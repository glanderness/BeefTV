package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func validateReplacementOutput(p cw.ReplacementPlan, f mediatools.MediaMetadata, audio bool) error {
	if !f.HasVideo || f.Width != p.Width || f.Height != p.Height || math.Abs(f.FPS-float64(p.FPS)) > 1e-6 || f.VideoFrames != int64(p.FrameCount) || audio && !f.HasAudio || math.Abs(float64(f.DurationMs)-float64(p.FrameCount)*1000/float64(p.FPS)) > 1000/float64(p.FPS)+2 {
		return fmt.Errorf("合成结果的尺寸、帧数、时长或音轨与原视频不符，未交付")
	}
	return nil
}

func replacementCommand(ctx context.Context, bin string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	mediatools.HideConsole(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("人物替换本地处理失败：%w：%.1200s", err, out)
	}
	return out, nil
}

func (w *taskWorkerCoordinator) replacementSource(user, id, path string) error {
	_, body, err := w.service.OpenResource(user, id)
	if err != nil {
		return err
	}
	defer body.Close()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, body)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func (w *taskWorkerCoordinator) processReplacementMedia(task *model.Task, ctx context.Context, input localtask.CanvasMediaInput) error {
	var payload map[string]any
	var err error
	if input.Node.OperationID == cw.ReplacementPrepareOperation {
		payload, err = w.prepareReplacement(task, ctx, input)
	} else {
		payload, err = w.finishReplacement(task, ctx, input)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return w.failTimelineTask(task, "人物替换处理失败", err.Error())
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	task.ResultJSON = string(b)
	task.Status = model.TaskStatusSucceeded
	task.Progress = 100
	task.Stage = "处理完成"
	now := time.Now()
	task.CompletedAt = &now
	if err = w.service.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return err
	}
	if err = w.service.DeliverSucceededTask(*task); err != nil {
		_ = w.service.log(task.UserID, task.ID, "error", "人物替换结果交付待恢复", err.Error())
	}
	return nil
}

var replacementPTS = regexp.MustCompile(`pts_time:([0-9.]+)`)

func (w *taskWorkerCoordinator) prepareReplacement(task *model.Task, ctx context.Context, input localtask.CanvasMediaInput) (map[string]any, error) {
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "beeftv-replacement-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	source := filepath.Join(dir, "source")
	if err = w.replacementSource(task.UserID, input.ResourceID, source); err != nil {
		return nil, err
	}
	facts, err := mediatools.ProbeLocal(ctx, source)
	if err != nil {
		return nil, err
	}
	if !facts.HasVideo {
		return nil, fmt.Errorf("输入没有视频轨道")
	}
	fps, err := cw.ReplacementFPS(facts.FPS)
	if err != nil {
		return nil, err
	}
	// Reject oversized inputs before decoding or any paid child admission.
	estimated := int(math.Round(float64(facts.DurationMs) * float64(fps) / 1000))
	limit := 12
	if n, ok := input.Node.Config["maxSegments"].(float64); ok {
		limit = int(n)
	}
	displayWidth := int(math.Ceil(float64(facts.Width) * facts.PixelAspectRatio))
	if _, err = cw.PlanCharacterReplacement(displayWidth, facts.Height, fps, estimated, nil, limit); err != nil {
		return nil, err
	}
	normalized := filepath.Join(dir, "normalized.mp4")
	if _, err = replacementCommand(ctx, bin, "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", source, "-map", "0:v:0", "-an", "-vf", fmt.Sprintf("fps=%d,scale=ceil(iw*sar/2)*2:ceil(ih/2)*2,setsar=1", fps), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", normalized); err != nil {
		return nil, err
	}
	normalizedFacts, err := mediatools.ProbeLocal(ctx, normalized)
	if err != nil {
		return nil, err
	}
	if normalizedFacts.VideoFrames < 1 {
		return nil, fmt.Errorf("无法读取标准化视频的完整帧数")
	}
	out, err := replacementCommand(ctx, bin, "-hide_banner", "-nostdin", "-i", normalized, "-an", "-vf", "select='gt(scene,0.45)',showinfo", "-f", "null", "-")
	if err != nil {
		return nil, err
	}
	var cuts []int
	for _, m := range replacementPTS.FindAllSubmatch(out, -1) {
		v, _ := strconv.ParseFloat(string(m[1]), 64)
		cuts = append(cuts, int(math.Round(v*float64(fps))))
	}
	p, err := cw.PlanCharacterReplacement(normalizedFacts.Width, normalizedFacts.Height, fps, int(normalizedFacts.VideoFrames), cuts, limit)
	if err != nil {
		return nil, err
	}
	p.SourceResourceID = input.ResourceID
	// Reference geometry meets provider bounds without changing the displayed aspect.
	scale := math.Max(1, math.Max(300/float64(min(p.Width, p.Height)), math.Sqrt(409600/float64(p.Width*p.Height))))
	scale = math.Min(scale, 2000/float64(max(p.Width, p.Height)))
	rw, rh := int(math.Ceil(float64(p.Width)*scale/2))*2, int(math.Ceil(float64(p.Height)*scale/2))*2
	videos := make([]map[string]any, 0, len(p.Segments))
	for i := range p.Segments {
		segment := p.Segments[i]
		path := filepath.Join(dir, fmt.Sprintf("segment-%d.mp4", i))
		var file *os.File
		resource, e := w.service.resourceDomain().RecoverOwned(task.UserID, fmt.Sprintf("%s:segment:%d", task.ID, i), func() (localasset.RecoveredArtifact, error) {
			filter := fmt.Sprintf("trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS,scale=%d:%d,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=%d", segment.ReferenceStartFrame, segment.ReferenceEndFrame, rw, rh, segment.ReferenceFrames)
			if _, e := replacementCommand(ctx, bin, "-v", "error", "-nostdin", "-y", "-i", normalized, "-an", "-vf", filter, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path); e != nil {
				return localasset.RecoveredArtifact{}, e
			}
			f, e := mediatools.ProbeLocal(ctx, path)
			if e != nil {
				return localasset.RecoveredArtifact{}, e
			}
			if f.VideoFrames != int64(segment.ReferenceFrames) {
				return localasset.RecoveredArtifact{}, fmt.Errorf("参考片段帧数不完整")
			}
			file, e = os.Open(path)
			if e != nil {
				return localasset.RecoveredArtifact{}, e
			}
			info, e := file.Stat()
			if e != nil {
				return localasset.RecoveredArtifact{}, e
			}
			if info.Size() > 50*1024*1024 {
				return localasset.RecoveredArtifact{}, fmt.Errorf("参考片段超过50MB，已在付费前停止")
			}
			return localasset.RecoveredArtifact{Kind: "video", FileName: fmt.Sprintf("replacement-reference-%d.mp4", i+1), MimeType: "video/mp4", Size: info.Size(), Width: rw, Height: rh, DurationMs: f.DurationMs, Body: file}, nil
		})
		if file != nil {
			file.Close()
		}
		if e != nil {
			return nil, e
		}
		p.Segments[i].ResourceID = resource.ID
		videos = append(videos, map[string]any{"resourceId": resource.ID, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs})
	}
	return map[string]any{"replacementPlan": p, "videos": videos}, nil
}

func (w *taskWorkerCoordinator) finishReplacement(task *model.Task, ctx context.Context, input localtask.CanvasMediaInput) (map[string]any, error) {
	p, err := cw.ReplacementManifest(input.Node)
	if err != nil {
		return nil, err
	}
	var artifact *os.File
	var dir string
	defer func() {
		if artifact != nil {
			artifact.Close()
		}
		if dir != "" {
			os.RemoveAll(dir)
		}
	}()
	resource, err := w.service.resourceDomain().RecoverOwned(task.UserID, task.ID+":0", func() (localasset.RecoveredArtifact, error) {
		bin, e := mediatools.ResolveFFmpeg()
		if e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		dir, e = os.MkdirTemp("", "beeftv-replacement-final-")
		if e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		source := filepath.Join(dir, "source")
		if e = w.replacementSource(task.UserID, p.SourceResourceID, source); e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		original, e := mediatools.ProbeLocal(ctx, source)
		if e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		args := []string{"-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", source}
		var filters []string
		var labels strings.Builder
		for i, segment := range p.Segments {
			path := filepath.Join(dir, fmt.Sprintf("generated-%d.mp4", i))
			if e = w.replacementSource(task.UserID, segment.OutputResourceID, path); e != nil {
				return localasset.RecoveredArtifact{}, e
			}
			f, e := mediatools.ProbeLocal(ctx, path)
			if e != nil {
				return localasset.RecoveredArtifact{}, e
			}
			needed := segment.EndFrame - segment.ReferenceStartFrame
			if !f.HasVideo || f.DurationMs*int64(p.FPS)+1000 < int64(needed)*1000 {
				return localasset.RecoveredArtifact{}, fmt.Errorf("第%d个生成视频时长不足，不能补帧冒充完整替换", i+1)
			}
			args = append(args, "-protocol_whitelist", "file,pipe", "-i", path)
			filters = append(filters, fmt.Sprintf("[%d:v]fps=%d,trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1[v%d]", i+1, p.FPS, segment.StartFrame-segment.ReferenceStartFrame, needed, p.Width, p.Height, p.Width, p.Height, i))
			fmt.Fprintf(&labels, "[v%d]", i)
		}
		filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=0[out]", labels.String(), len(p.Segments)))
		args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[out]")
		if original.HasAudio {
			args = append(args, "-map", "0:a:0", "-af", fmt.Sprintf("apad,atrim=duration=%.9f", float64(p.FrameCount)/float64(p.FPS)), "-c:a", "aac", "-b:a", "192k")
		} else {
			args = append(args, "-an")
		}
		output := filepath.Join(dir, "replacement.mp4")
		args = append(args, "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output)
		if _, e = replacementCommand(ctx, bin, args...); e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		f, e := mediatools.ProbeLocal(ctx, output)
		if e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		if e = validateReplacementOutput(p, f, original.HasAudio); e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		if _, e = replacementCommand(ctx, bin, "-v", "error", "-nostdin", "-i", output, "-f", "null", "-"); e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		artifact, e = os.Open(output)
		if e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		info, e := artifact.Stat()
		if e != nil {
			return localasset.RecoveredArtifact{}, e
		}
		return localasset.RecoveredArtifact{Kind: "video", FileName: "character-replacement.mp4", MimeType: "video/mp4", Size: info.Size(), Width: f.Width, Height: f.Height, DurationMs: f.DurationMs, Body: artifact}, nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"resourceId": resource.ID, "video": map[string]any{"resourceId": resource.ID, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}}, nil
}
