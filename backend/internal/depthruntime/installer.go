package depthruntime

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Manifest struct {
	Version int      `json:"version"`
	Runtime Artifact `json:"runtime"`
	Model   Artifact `json:"model"`
}

type EnsureOptions struct {
	ManifestURL      string
	DataDir          string
	Progress         func(component string, progress Progress)
	FallbackManifest *Manifest
}

type Installation struct {
	Python       string
	ToolDir      string
	ModelRuntime string
}

func Ensure(ctx context.Context, options EnsureOptions) (Installation, error) {
	manifest, err := fetchManifest(ctx, options.ManifestURL)
	if err != nil {
		if options.FallbackManifest == nil {
			return Installation{}, err
		}
		manifest = *options.FallbackManifest
	}
	if manifest.Version != 1 {
		return Installation{}, fmt.Errorf("不支持的深度组件清单版本 %d", manifest.Version)
	}
	runtimeRoot := filepath.Join(options.DataDir, "runtimes", "depth", "v1", "darwin-arm64")
	modelRuntime := filepath.Join(options.DataDir, "models", "video-depth-anything-small", "v1")
	python := filepath.Join(runtimeRoot, ".venv", "bin", "python")
	bundledPython := filepath.Join(runtimeRoot, ".python", "bin", "python3.11")
	toolDir := filepath.Join(runtimeRoot, "worker")
	modelPath := filepath.Join(modelRuntime, "checkpoints", "video_depth_anything_vits.pth")
	archivePath := filepath.Join(options.DataDir, "downloads", "depth-runtime-v1-darwin-arm64.zip")
	if !fileMatches(archivePath, manifest.Runtime) || !pathExecutable(python) || !pathExecutable(bundledPython) || !pathExists(filepath.Join(toolDir, "depth_capture")) {
		if !fileMatches(archivePath, manifest.Runtime) {
			if err := Download(ctx, manifest.Runtime, archivePath, componentProgress(options.Progress, "runtime")); err != nil {
				return Installation{}, err
			}
		}
		if err := os.MkdirAll(filepath.Dir(runtimeRoot), 0o750); err != nil {
			return Installation{}, err
		}
		stage, err := os.MkdirTemp(filepath.Dir(runtimeRoot), ".depth-runtime-stage-*")
		if err != nil {
			return Installation{}, err
		}
		defer os.RemoveAll(stage)
		if err := extractRuntimeArchive(archivePath, stage, manifest.Runtime); err != nil {
			return Installation{}, err
		}
		if err := os.Chmod(filepath.Join(stage, ".venv", "bin", "python"), 0o750); err != nil {
			return Installation{}, fmt.Errorf("深度组件缺少可执行 Python: %w", err)
		}
		if !pathExecutable(filepath.Join(stage, ".python", "bin", "python3.11")) {
			return Installation{}, errors.New("深度组件内置 Python 不可执行")
		}
		_ = os.RemoveAll(runtimeRoot)
		if err := os.Rename(stage, runtimeRoot); err != nil {
			return Installation{}, fmt.Errorf("发布深度组件失败: %w", err)
		}
	}
	if !fileMatches(modelPath, manifest.Model) {
		if err := Download(ctx, manifest.Model, modelPath, componentProgress(options.Progress, "model")); err != nil {
			return Installation{}, err
		}
	}
	return Installation{Python: python, ToolDir: toolDir, ModelRuntime: modelRuntime}, nil
}

func fetchManifest(ctx context.Context, rawURL string) (Manifest, error) {
	if strings.TrimSpace(rawURL) == "" {
		return Manifest{}, errors.New("未配置深度组件下载清单")
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			cancel()
			return Manifest{}, err
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		var manifest Manifest
		if response.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("深度组件清单返回 HTTP %d", response.StatusCode)
			_ = response.Body.Close()
			cancel()
			continue
		}
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&manifest)
		_ = response.Body.Close()
		cancel()
		if decodeErr != nil {
			lastErr = fmt.Errorf("解析深度组件清单失败: %w", decodeErr)
			continue
		}
		return manifest, nil
	}
	return Manifest{}, fmt.Errorf("获取深度组件清单失败: %w", lastErr)
}

func extractRuntimeArchive(path string, destination string, artifact Artifact) error {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("打开深度组件压缩包失败: %w", err)
	}
	defer reader.Close()
	var declaredExpanded int64
	for _, entry := range reader.File {
		declaredExpanded += int64(entry.UncompressedSize64)
	}
	if err := validateArchiveShape(len(reader.File), declaredExpanded, artifact); err != nil {
		return err
	}
	var expanded int64
	for _, entry := range reader.File {
		clean := filepath.Clean(filepath.FromSlash(entry.Name))
		if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return errors.New("深度组件压缩包包含越界路径")
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("深度组件压缩包不允许符号链接")
		}
		expanded += int64(entry.UncompressedSize64)
		if expanded > 3<<30 {
			return errors.New("深度组件解压体积超过限制")
		}
		target := filepath.Join(destination, clean)
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return err
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(output, source)
		closeErr := output.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if entry.Mode().Perm()&0o111 != 0 {
			if err := os.Chmod(target, 0o750); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateArchiveShape(files int, expandedSize int64, artifact Artifact) error {
	if files > 50_000 {
		return errors.New("深度组件压缩包文件数量超过安全上限")
	}
	if expandedSize > 3<<30 {
		return errors.New("深度组件解压体积超过安全上限")
	}
	if artifact.Files > 0 && files != artifact.Files {
		return fmt.Errorf("深度组件压缩包文件数量与发布清单不一致: got %d want %d", files, artifact.Files)
	}
	if artifact.ExpandedSize > 0 && expandedSize != artifact.ExpandedSize {
		return fmt.Errorf("深度组件解压体积与发布清单不一致: got %d want %d", expandedSize, artifact.ExpandedSize)
	}
	return nil
}

func componentProgress(report func(string, Progress), component string) func(Progress) {
	if report == nil {
		return nil
	}
	return func(progress Progress) { report(component, progress) }
}

func fileMatches(path string, artifact Artifact) bool { return verifyFile(path, artifact) == nil }
func pathExists(path string) bool                     { _, err := os.Stat(path); return err == nil }
func pathExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}
