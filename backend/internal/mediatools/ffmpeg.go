// Package mediatools resolves the desktop-owned native media runtime.
package mediatools

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const FFmpegPathEnv = "CANVAS_FFMPEG_PATH"

func ResolveFFmpeg() (string, error) {
	if configured := strings.TrimSpace(os.Getenv(FFmpegPathEnv)); configured != "" {
		return configured, nil
	}
	executable, err := os.Executable()
	if err == nil {
		if resolved, e := filepath.EvalSymlinks(executable); e == nil {
			executable = resolved
		}
		if bundled := bundledFFmpeg(executable); bundled != "" {
			return bundled, nil
		}
	}
	if path, err := exec.LookPath("ffmpeg"); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("视频处理工具不可用，请重新安装应用")
}

func bundledFFmpeg(executable string) string {
	dir := filepath.Dir(executable)
	if filepath.Base(dir) == "cli" {
		dir = filepath.Dir(dir)
	}
	for _, media := range []string{filepath.Join(dir, "agent-host", "media-runtime"), filepath.Join(dir, "media-runtime")} {
		for _, name := range []string{"ffmpeg.exe", "ffmpeg"} {
			candidate := filepath.Join(media, name)
			if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
				return candidate
			}
		}
	}
	return ""
}
