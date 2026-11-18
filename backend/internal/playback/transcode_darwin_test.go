//go:build darwin

package playback

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRunH264TranscodeFallsBackToAvconvertWhenBundledFFmpegFails(t *testing.T) {
	if _, err := exec.LookPath("avconvert"); err != nil {
		t.Skip("avconvert unavailable")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required to create source fixture")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=64x48:r=10:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v %s", err, out)
	}
	// Put a failing fake ffmpeg first on PATH with CANVAS_FFMPEG_PATH unset so
	// ResolveFFmpeg resolves the failing binary and runH264Transcode exercises avconvert fallback.
	fakeBinDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(fakeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeFFmpeg := filepath.Join(fakeBinDir, "ffmpeg")
	if err := os.WriteFile(fakeFFmpeg, []byte("#!/bin/sh\necho 'simulated unsupported codec' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CANVAS_FFMPEG_PATH", "")
	t.Setenv("PATH", fakeBinDir+":/usr/bin:/bin:/usr/sbin:/sbin")

	dst := filepath.Join(dir, "out.mp4")
	if err := runH264Transcode(context.Background(), src, dst); err != nil {
		t.Fatalf("expected avconvert fallback to succeed, got: %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil || info.Size() == 0 {
		t.Fatalf("missing fallback output: %v", err)
	}
}
