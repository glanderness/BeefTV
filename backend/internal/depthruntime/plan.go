package depthruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/desktopstorage"
)

const (
	officialCNBBase = "https://cnb.cool/beeftv-downloads/desktop/-/releases/download/depth-runtime-v2/"
	officialCOSBase = "https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/"
	officialR2Base  = "https://updates.beefapi.com/beeftv/components/depth-runtime-v2/"
	officialGHBase  = "https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/"
	officialModelGH = "https://github.com/glanderness/BeefTV/releases/download/v1.5.5/video_depth_anything_vits.pth"
)

var ErrNotInstalled = errors.New("深度捕捉组件尚未安装，请在设置的存储页面下载后再使用")

const modelSize = int64(116440756)
const modelSHA = "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609"

type Plan struct {
	DownloadBytes int64  `json:"downloadBytes"`
	RequiredBytes int64  `json:"requiredBytes"`
	FreeBytes     uint64 `json:"freeBytes"`
}

// Inspect uses installed files only. It never fetches a manifest or runs Python.
func Inspect(ctx context.Context, dataDir, platform, variant string) (Installation, error) {
	paths, err := runtimeLayout(dataDir, platform, variant)
	if err != nil {
		return Installation{}, err
	}
	modelRuntime := filepath.Join(dataDir, "models", "video-depth-anything-small", "v1")
	model := filepath.Join(modelRuntime, "checkpoints", "video_depth_anything_vits.pth")
	expected := Artifact{Size: modelSize, SHA256: modelSHA}
	if raw, err := os.ReadFile(filepath.Join(paths.Root, ".installation.json")); err == nil {
		var installed Artifact
		if json.Unmarshal(raw, &installed) == nil && installed.Size > 0 && len(installed.SHA256) == 64 {
			expected = installed
		}
	}
	if !installedRuntime(paths, platform) {
		return Installation{}, ErrNotInstalled
	}
	if err := verifyFileContext(ctx, model, expected); err != nil {
		return Installation{}, ErrNotInstalled
	}
	return Installation{Python: paths.Python, ToolDir: paths.ToolDir, ModelRuntime: modelRuntime}, nil
}

// DownloadPlan fetches metadata only, using the same signature checks as Ensure.
func DownloadPlan(ctx context.Context, options EnsureOptions) (Plan, error) {
	paths, err := runtimeLayout(options.DataDir, options.Platform, options.Variant)
	if err != nil {
		return Plan{}, err
	}
	manifest, artifact, err := loadArtifacts(ctx, options)
	if err != nil {
		return Plan{}, err
	}
	runtimeReady := installedRuntime(paths, options.Platform)
	archiveReady := runtimeReady || verifyFileContext(ctx, paths.Archive, artifact) == nil
	modelPath := filepath.Join(options.DataDir, "models", "video-depth-anything-small", "v1", "checkpoints", "video_depth_anything_vits.pth")
	return installationPlan(options.DataDir, artifact, manifest.Model, archiveReady, verifyFileContext(ctx, modelPath, manifest.Model) == nil, runtimeReady)
}

func installedRuntime(paths runtimePaths, platform string) bool {
	pythonReady := pathExecutable(paths.Python) && pathExecutable(paths.BundledPython)
	if platform == "windows-amd64" {
		pythonReady = pathRegular(paths.Python) && pathRegular(paths.BundledPython)
	}
	info, err := os.Stat(filepath.Join(paths.ToolDir, "depth_capture"))
	return pythonReady && err == nil && info.IsDir()
}

// Metadata preview and installation must use the same version and trust rules.
func loadArtifacts(ctx context.Context, options EnsureOptions) (Manifest, Artifact, error) {
	windows := options.Platform == "windows-amd64"
	manifest, err := fetchManifestSources(ctx, options)
	if err != nil {
		if ctx.Err() != nil {
			return Manifest{}, Artifact{}, ctx.Err()
		}
		if windows || options.FallbackManifest == nil {
			return Manifest{}, Artifact{}, err
		}
		manifest = *options.FallbackManifest
	}
	if (windows && manifest.Version != 2) || (!windows && manifest.Version != 1) {
		return Manifest{}, Artifact{}, fmt.Errorf("不支持的深度组件清单版本 %d", manifest.Version)
	}
	normalizeManifestMirrors(&manifest)
	artifact := manifest.Runtime
	if windows {
		var ok bool
		artifact, ok = manifest.Runtimes[options.Platform+"/"+options.Variant]
		if !ok {
			return Manifest{}, Artifact{}, errors.New("深度组件清单缺少对应的 Windows 运行包")
		}
		if artifact.Files <= 0 || artifact.ExpandedSize <= 0 {
			return Manifest{}, Artifact{}, errors.New("Windows 深度组件清单缺少解压体积或文件数")
		}
	}
	if artifact.Size <= 0 || manifest.Model.Size <= 0 {
		return Manifest{}, Artifact{}, errors.New("深度组件清单缺少下载大小")
	}
	return manifest, artifact, nil
}

func installationPlan(dataDir string, artifact, model Artifact, archiveReady, modelReady, runtimeReady bool) (Plan, error) {
	var plan Plan
	if !archiveReady {
		plan.DownloadBytes += artifact.Size
		plan.RequiredBytes += artifact.Size
		if len(artifact.Parts) > 0 {
			plan.RequiredBytes += artifact.Size
		}
	}
	if !runtimeReady {
		plan.RequiredBytes += artifact.ExpandedSize
	}
	if !modelReady {
		plan.DownloadBytes += model.Size
		plan.RequiredBytes += model.Size
	}
	plan.RequiredBytes += 256 << 20
	// Query the containing volume without scanning the user's media library.
	var err error
	plan.FreeBytes, err = desktopstorage.FreeBytes(dataDir)
	return plan, err
}

func normalizeManifestMirrors(manifest *Manifest) {
	if manifest == nil {
		return
	}
	manifest.Runtime = normalizeArtifactMirrors(manifest.Runtime)
	manifest.Model = normalizeArtifactMirrors(manifest.Model)
	if len(manifest.Runtimes) > 0 {
		normalized := make(map[string]Artifact, len(manifest.Runtimes))
		for key, item := range manifest.Runtimes {
			normalized[key] = normalizeArtifactMirrors(item)
		}
		manifest.Runtimes = normalized
	}
}

func normalizeArtifactMirrors(artifact Artifact) Artifact {
	if len(artifact.URLs) > 0 {
		artifact.URLs = normalizeOfficialURLs(artifact.URLs)
	}
	if len(artifact.Parts) > 0 {
		parts := make([]ArtifactPart, len(artifact.Parts))
		for index, part := range artifact.Parts {
			part.URLs = normalizeOfficialURLs(part.URLs)
			parts[index] = part
		}
		artifact.Parts = parts
	}
	return artifact
}

func normalizeOfficialURLs(urls []string) []string {
	if len(urls) == 0 {
		return urls
	}
	var fileName string
	var buckets [5][]string
	for _, raw := range urls {
		bucket, name, ok := classifyOfficialDepthURL(raw)
		if !ok {
			return urls
		}
		if fileName == "" {
			fileName = name
		} else if fileName != name {
			return urls
		}
		buckets[bucket] = append(buckets[bucket], strings.TrimSpace(raw))
	}
	if fileName == "" {
		return urls
	}
	buckets[0] = append([]string{officialCNBBase + fileName}, buckets[0]...)
	buckets[1] = append([]string{officialCOSBase + fileName}, buckets[1]...)
	buckets[2] = append([]string{officialR2Base + fileName}, buckets[2]...)
	if len(buckets[3]) == 0 {
		if fileName == "video_depth_anything_vits.pth" {
			buckets[3] = []string{officialModelGH}
		} else {
			buckets[3] = []string{officialGHBase + fileName}
		}
	}
	seen := make(map[string]struct{}, len(urls)+4)
	ordered := make([]string, 0, len(urls)+4)
	for _, group := range buckets {
		for _, candidate := range group {
			if _, exists := seen[candidate]; exists {
				continue
			}
			seen[candidate] = struct{}{}
			ordered = append(ordered, candidate)
		}
	}
	return ordered
}

func classifyOfficialDepthURL(rawURL string) (bucket int, fileName string, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return -1, "", false
	}
	base := path.Base(parsed.Path)
	if base == "" || base == "." || base == "/" || strings.ContainsAny(base, `/\`) {
		return -1, "", false
	}
	switch {
	case parsed.Host == "cnb.cool" && strings.HasPrefix(parsed.Path, "/beeftv-downloads/"):
		return 0, base, true
	case parsed.Host == "beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com":
		return 1, base, true
	case parsed.Host == "updates.beefapi.com":
		return 2, base, true
	case parsed.Host == "github.com" && strings.HasPrefix(parsed.Path, "/glanderness/BeefTV/"):
		return 3, base, true
	case parsed.Host == "huggingface.co":
		return 4, base, true
	default:
		return -1, "", false
	}
}
