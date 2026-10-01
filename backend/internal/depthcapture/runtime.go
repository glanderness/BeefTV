package depthcapture

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) resolveRuntime(ctx context.Context, task *model.Task, platform, variant string) (python string, toolDir string, modelRuntime string, err error) {
	python = strings.TrimSpace(s.getenv(pythonEnv))
	toolDir = strings.TrimSpace(s.getenv(toolDirEnv))
	modelRuntime = strings.TrimSpace(s.getenv(runtimeEnv))
	if python != "" && toolDir != "" && modelRuntime != "" {
		if s.stat(python) == nil {
			return python, toolDir, modelRuntime, nil
		}
	}
	manifestURL := strings.TrimSpace(s.getenv(manifestEnv))
	if manifestURL == "" {
		if platform == "windows-amd64" {
			manifestURL = defaultWindowsManifestURL
		} else {
			manifestURL = defaultManifestURL
		}
	}
	var publicKey ed25519.PublicKey
	var fallback *depthruntime.Manifest
	if platform == "windows-amd64" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(s.windowsKey)
		if decodeErr != nil || len(decoded) != ed25519.PublicKeySize {
			return "", "", "", ErrWindowsKey
		}
		publicKey = decoded
	} else {
		fallback = defaultFallbackManifest()
	}
	installation, ensureErr := s.ensure(ctx, depthruntime.EnsureOptions{
		ManifestURL:      manifestURL,
		DataDir:          s.dataDir,
		Platform:         platform,
		Variant:          variant,
		TrustedPublicKey: publicKey,
		FallbackManifest: fallback,
		Progress: func(component string, progress depthruntime.Progress) {
			percent := 0
			downloadedMB := float64(progress.Downloaded) / (1024 * 1024)
			totalMB := float64(progress.Total) / (1024 * 1024)
			if progress.Total > 0 {
				percent = int(progress.Downloaded * 100 / progress.Total)
			}
			stage := fmt.Sprintf("下载深度处理组件 %.1f / %.1f MB（%d%%）", downloadedMB, totalMB, percent)
			taskProgress := min(12, percent/10+1)
			if component == "model" {
				stage = fmt.Sprintf("下载 Small 模型 %.1f / %.1f MB（%d%%）", downloadedMB, totalMB, percent)
				taskProgress = 12 + min(8, percent*8/100)
			}
			_ = s.progress(task, stage, taskProgress)
		},
	})
	if ensureErr != nil {
		return "", "", "", ensureErr
	}
	return installation.Python, installation.ToolDir, installation.ModelRuntime, nil
}

func defaultFallbackManifest() *depthruntime.Manifest {
	return &depthruntime.Manifest{
		Version: 1,
		Runtime: depthruntime.Artifact{
			URLs:         []string{"https://github.com/glanderness/BeefTV/releases/download/v1.5.5/beeftv-depth-runtime-v1-darwin-arm64.zip"},
			Size:         294629974,
			SHA256:       "f606dee084ec9d38d76a80e409e4cb9a80ad7db51c18778285a63e8f24376682",
			Files:        23_481,
			ExpandedSize: 955_790_953,
		},
		Model: depthruntime.Artifact{
			URLs: []string{
				"https://github.com/glanderness/BeefTV/releases/download/v1.5.5/video_depth_anything_vits.pth",
				"https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth",
			},
			Size:   116440756,
			SHA256: "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609",
		},
	}
}
