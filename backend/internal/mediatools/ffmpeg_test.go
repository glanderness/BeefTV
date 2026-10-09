package mediatools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBundledFFmpegRelocationAndCLI(t *testing.T) {
	root := filepath.Join(t.TempDir(), "中文 install with spaces")
	want := filepath.Join(root, "media-runtime", "ffmpeg.exe")
	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(want, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []string{filepath.Join(root, "BeefTV.exe"), filepath.Join(root, "cli", "beeftv.exe")} {
		if got := bundledFFmpeg(executable); got != want {
			t.Fatalf("bundle resolution: %q != %q", got, want)
		}
	}
}

func TestExplicitFFmpegOverrideDoesNotFallBack(t *testing.T) {
	want := filepath.Join(t.TempDir(), "missing.exe")
	t.Setenv(FFmpegPathEnv, want)
	got, err := ResolveFFmpeg()
	if err != nil || got != want {
		t.Fatalf("override = %q, %v", got, err)
	}
}
