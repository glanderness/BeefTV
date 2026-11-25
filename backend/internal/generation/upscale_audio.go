package generation

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/outbound"
)

func validateUpscaleVideoFacts(facts mediatools.MediaMetadata) error {
	if !facts.HasVideo || facts.DurationMs <= 0 || facts.DurationMs > 300_000 || !strings.Contains(","+facts.FormatName+",", ",mov,") && !strings.Contains(","+facts.FormatName+",", ",mp4,") {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "超分视频须为不超过 5 分钟的 MP4 或 MOV", Action: "请裁剪时长或转码为 MP4/MOV 后重试"}
	}
	if facts.HasAudio {
		if _, err := mediatools.ResolveFFmpeg(); err != nil {
			return err
		}
	}
	return nil
}

// PreserveUpscaleAudioFile preserves sourcePath's audio track onto outputPath
// directly on disk using stream-copy video remuxing (-c:v copy), keeping memory
// usage constant regardless of video size. When no remux is needed, it returns
// outputPath directly with a no-op cleanup.
func PreserveUpscaleAudioFile(ctx context.Context, sourcePath, outputPath string) (string, func(), error) {
	noop := func() {}
	sourceFacts, err := mediatools.ProbeLocal(ctx, sourcePath)
	if err != nil {
		return "", noop, err
	}
	outputFacts, err := mediatools.ProbeLocal(ctx, outputPath)
	if err != nil {
		return "", noop, err
	}
	if !outputFacts.HasVideo || outputFacts.DurationMs <= 0 {
		return "", noop, errors.New("超分结果没有有效的视频画面")
	}
	if !sourceFacts.HasAudio || outputFacts.HasAudio {
		return outputPath, noop, nil
	}
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		return "", noop, err
	}
	head, err := outbound.ReadFilePrefix(outputPath, 512)
	if err != nil {
		return "", noop, err
	}
	isQuickTime := NormalizedMediaMIMEType("", head) == "video/quicktime"
	// Keep 1-2 GiB remux scratch on the same filesystem as outputPath (typically
	// dataDir/cache/artifact-downloads) instead of RAM-backed /tmp, so orphan
	// cleanup reclaims it on crash and tmpfs never runs out of space.
	parentDir := filepath.Dir(outputPath)
	dir, err := os.MkdirTemp(parentDir, ".beeftv-remux-")
	if err != nil {
		dir, err = os.MkdirTemp("", "beeftv-upscale-audio-")
	}
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	resultName := "result.mp4"
	if isQuickTime {
		resultName = "result.mov"
	}
	result := filepath.Join(dir, resultName)
	args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", outputPath, "-protocol_whitelist", "file,pipe", "-i", sourcePath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", strconv.FormatFloat(float64(outputFacts.DurationMs)/1000, 'f', 3, 64)}
	if isQuickTime {
		args = append(args, "-f", "mov")
	}
	args = append(args, "-movflags", "+faststart", result)
	cmd := exec.CommandContext(ctx, bin, args...)
	mediatools.HideConsole(cmd)
	if err := cmd.Run(); err != nil {
		cleanup()
		return "", noop, errors.New("原视频音轨补回失败，请取回原任务结果重试")
	}
	info, err := os.Stat(result)
	if err != nil {
		cleanup()
		return "", noop, err
	}
	limit := MaxResponseBytes
	if runtime, ok := RuntimeFromContext(ctx); ok && runtime.Limits != nil {
		limit, err = runtime.Limits.GeneratedFileBytes(ctx)
		if err != nil {
			cleanup()
			return "", noop, err
		}
	}
	if info.Size() > limit {
		cleanup()
		return "", noop, errors.New("补回音轨后的视频超过资源大小限制")
	}
	facts, err := mediatools.ProbeLocal(ctx, result)
	if err != nil || !facts.HasVideo || !facts.HasAudio {
		cleanup()
		return "", noop, errors.New("补回音轨后的视频校验失败")
	}
	return result, cleanup, nil
}
