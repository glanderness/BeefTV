package playback

import (
	"bytes"
	"context"
	"fmt"
	"infinite-canvas/backend/internal/mediatools"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func runH264Transcode(ctx context.Context, src string, dst string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	binary, err := mediatools.ResolveFFmpeg()
	if err != nil {
		if runtime.GOOS == "darwin" {
			return runNativeH264Transcode(ctx, src, dst)
		}
		return err
	}
	if !mediatools.SupportsH264Encode(binary) {
		if runtime.GOOS == "darwin" && strings.TrimSpace(os.Getenv(mediatools.FFmpegPathEnv)) == "" {
			return runNativeH264Transcode(ctx, src, dst)
		}
		return fmt.Errorf("本机媒体编码器缺少 H.264 视频编码支持")
	}
	encodeArgs := mediatools.PreferredH264VideoArgs(binary, "veryfast", "23", "5M", "8M")
	cmdArgs := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-protocol_whitelist", "file,pipe", "-i", src}
	cmdArgs = append(cmdArgs, encodeArgs...)
	cmdArgs = append(cmdArgs,
		"-threads", "2", "-filter_threads", "1",
		"-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		dst,
	)
	cmd := exec.CommandContext(ctx, binary, cmdArgs...)
	mediatools.HideConsole(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_ = os.Remove(dst)
		if runtime.GOOS == "darwin" && strings.TrimSpace(os.Getenv(mediatools.FFmpegPathEnv)) == "" {
			if nativeErr := runNativeH264Transcode(ctx, src, dst); nativeErr == nil {
				return nil
			}
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg 转码失败：%s", clipText(msg, 800))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func runNativeH264Transcode(ctx context.Context, src string, dst string) error {
	output := dst + ".m4v"
	defer os.Remove(output)
	cmd := exec.CommandContext(ctx, "avconvert", "--source", src, "--preset", "PresetHighestQuality", "--output", output, "--replace")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("系统视频转换失败：%s", clipText(strings.TrimSpace(stderr.String()), 800))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(output, dst)
}

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
