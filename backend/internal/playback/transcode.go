package playback

import (
	"bytes"
	"context"
	"fmt"
	"infinite-canvas/backend/internal/mediatools"
	"os"
	"os/exec"
	"path/filepath"
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
		return err
	}
	cmd := exec.CommandContext(ctx, binary, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", "2", "-i", src,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
		"-threads", "2", "-filter_threads", "1",
		"-pix_fmt", "yuv420p", "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		dst)
	mediatools.HideConsole(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
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

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
