// Package mediatools resolves the desktop-owned native media runtime.
package mediatools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ffmpegEncodersCache sync.Map
	ffmpegFiltersCache  sync.Map
)

// SupportsFFmpegEncoder reports whether bin advertises the named encoder.
func SupportsFFmpegEncoder(bin, encoder string) bool {
	return strings.Contains(cachedFFmpegListing(&ffmpegEncodersCache, bin, "-encoders"), " "+encoder+" ")
}

// SupportsFFmpegFilter reports whether bin advertises the named filter.
func SupportsFFmpegFilter(bin, filter string) bool {
	return strings.Contains(cachedFFmpegListing(&ffmpegFiltersCache, bin, "-filters"), " "+filter+" ")
}

// SupportsH264Encode reports whether bin advertises a supported H.264 encoder.
func SupportsH264Encode(bin string) bool {
	return SupportsFFmpegEncoder(bin, "libx264") || SupportsFFmpegEncoder(bin, "h264_videotoolbox")
}

// PreferredH264VideoArgs returns libx264 arguments by default and switches to
// Apple VideoToolbox when the bundled LGPL runtime exposes h264_videotoolbox without libx264.
func PreferredH264VideoArgs(bin, preset, crf, vtBitrate, vtMaxrate string) []string {
	if !SupportsFFmpegEncoder(bin, "libx264") && SupportsFFmpegEncoder(bin, "h264_videotoolbox") {
		return []string{"-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", vtBitrate, "-maxrate", vtMaxrate, "-bufsize", vtMaxrate, "-pix_fmt", "yuv420p"}
	}
	args := []string{"-c:v", "libx264"}
	if preset != "" {
		args = append(args, "-preset", preset)
	}
	if crf != "" {
		args = append(args, "-crf", crf)
	}
	return append(args, "-pix_fmt", "yuv420p")
}

func cachedFFmpegListing(cache *sync.Map, bin, flag string) string {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return ""
	}
	key := bin
	if info, err := os.Stat(bin); err == nil {
		key = fmt.Sprintf("%s\x00%d\x00%d", bin, info.Size(), info.ModTime().UnixNano())
	}
	if value, ok := cache.Load(key); ok {
		return value.(string)
	}
	tmpDir, err := os.MkdirTemp("", "beeftv-ffmpeg-caps-")
	if err != nil {
		return ""
	}
	defer os.RemoveAll(tmpDir)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-hide_banner", flag)
	cmd.Dir = tmpDir
	HideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	text := string(out)
	cache.Store(key, text)
	return text
}

const FFmpegPathEnv = "CANVAS_FFMPEG_PATH"
const FFprobePathEnv = "CANVAS_FFPROBE_PATH"

var ErrToolUnavailable = errors.New("media tool unavailable")

func ResolveFFmpeg() (string, error) {
	return resolveTool("ffmpeg", FFmpegPathEnv)
}

func ResolveFFprobe() (string, error) {
	return resolveTool("ffprobe", FFprobePathEnv)
}

func resolveTool(name, env string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv(env)); configured != "" {
		return configured, nil
	}
	executable, err := os.Executable()
	if err == nil {
		if resolved, e := filepath.EvalSymlinks(executable); e == nil {
			executable = resolved
		}
		if bundled := bundledTool(executable, name); bundled != "" {
			return bundled, nil
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("%w：视频处理工具不可用，请重新安装应用", ErrToolUnavailable)
}

func bundledFFmpeg(executable string) string {
	return bundledTool(executable, "ffmpeg")
}

func bundledTool(executable, tool string) string {
	dir := filepath.Dir(executable)
	if filepath.Base(dir) == "cli" {
		dir = filepath.Dir(dir)
	}
	mediaDirs := []string{filepath.Join(dir, "agent-host", "media-runtime"), filepath.Join(dir, "media-runtime")}
	if filepath.Base(dir) == "MacOS" && filepath.Base(filepath.Dir(dir)) == "Contents" {
		mediaDirs = append([]string{filepath.Join(filepath.Dir(dir), "Resources", "agent-host", "media-runtime")}, mediaDirs...)
	}
	for _, media := range mediaDirs {
		for _, name := range []string{tool + ".exe", tool} {
			candidate := filepath.Join(media, name)
			if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
				return candidate
			}
		}
	}
	return ""
}
