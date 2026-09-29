package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/model"
)

const (
	depthPythonEnv                 = "BEEFTV_DEPTH_PYTHON"
	depthToolDirEnv                = "BEEFTV_DEPTH_TOOL_DIR"
	depthRuntimeEnv                = "BEEFTV_DEPTH_RUNTIME"
	depthManifestEnv               = "BEEFTV_DEPTH_MANIFEST_URL"
	defaultDepthManifestURL        = "https://github.com/glanderness/BeefTV/releases/download/v1.5.5/depth-runtime-manifest.json"
	defaultWindowsDepthManifestURL = "https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/depth-runtime-manifest.v2.json"
)

// Set only when building a signed Windows depth release. An empty value keeps
// the Windows feature closed instead of trusting an unsigned remote manifest.
var depthWindowsManifestPublicKeyBase64 string

type depthCaptureResult struct {
	ResourceID     string  `json:"resourceId"`
	FileName       string  `json:"fileName"`
	Size           int64   `json:"size"`
	DurationMs     int64   `json:"durationMs"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	FPS            float64 `json:"fps,omitempty"`
	Device         string  `json:"device,omitempty"`
	FallbackReason string  `json:"fallbackReason,omitempty"`
	RuntimeVersion string  `json:"runtimeVersion,omitempty"`
	ProcessingMs   int64   `json:"processingMs,omitempty"`
}

func (w *taskWorkerCoordinator) processDepthCapture(task *model.Task, ctx context.Context) error {
	if (runtime.GOOS != "darwin" || runtime.GOARCH != "arm64") && (runtime.GOOS != "windows" || runtime.GOARCH != "amd64") {
		return w.failTimelineTask(task, "深度处理不可用", "当前版本仅支持 Apple Silicon Mac 和 Windows x64")
	}
	var input depthCaptureInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || strings.TrimSpace(input.ResourceID) == "" {
		return w.failTimelineTask(task, "深度处理失败", "任务缺少有效的视频资源引用")
	}
	resource, reader, err := w.service.OpenResource(task.UserID, input.ResourceID)
	if err != nil || resource == nil || reader == nil {
		return w.failTimelineTask(task, "深度处理失败", "无法读取待处理视频，可能已被删除")
	}
	defer reader.Close()
	if !strings.HasPrefix(resource.MimeType, "video/") {
		return w.failTimelineTask(task, "深度处理失败", "深度动作捕捉仅支持视频资源")
	}
	if resource.DurationMs > 15_100 {
		return w.failTimelineTask(task, "视频过长", "视频超过 15 秒，请先使用视频剪辑缩短")
	}
	started := time.Now()
	platform := "darwin-arm64"
	if runtime.GOOS == "windows" {
		platform = "windows-amd64"
	}
	var cudaPython, cudaToolDir, cudaModelRuntime string
	choice, err := chooseDepthDevice(ctx, runtime.GOOS, runtime.GOARCH, depthHasNVIDIACandidate(ctx), func(probeCtx context.Context) error {
		if progressErr := w.progress(task, "验证 CUDA 深度模型", 2); progressErr != nil {
			return progressErr
		}
		var resolveErr error
		cudaPython, cudaToolDir, cudaModelRuntime, resolveErr = w.resolveDepthRuntime(probeCtx, task, platform, "cuda")
		if resolveErr != nil {
			return resolveErr
		}
		return probeDepthCUDA(probeCtx, cudaPython, cudaToolDir, cudaModelRuntime)
	})
	if err != nil {
		return w.failTimelineTask(task, "深度组件不可用", err.Error())
	}
	python, toolDir, modelRuntime := cudaPython, cudaToolDir, cudaModelRuntime
	if choice.Device != "cuda" {
		python, toolDir, modelRuntime, err = w.resolveDepthRuntime(ctx, task, platform, choice.Variant)
	}
	if err != nil {
		return w.failTimelineTask(task, "深度组件不可用", err.Error())
	}
	if err := w.progress(task, "准备视频", 8); err != nil {
		return err
	}
	workDir, err := os.MkdirTemp("", "beeftv-depth-*")
	if err != nil {
		return w.failTimelineTask(task, "深度处理失败", "无法创建安全的临时目录")
	}
	defer os.RemoveAll(workDir)
	inputPath := filepath.Join(workDir, "input.mp4")
	inputFile, err := os.OpenFile(inputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return w.failTimelineTask(task, "深度处理失败", "无法准备输入视频")
	}
	_, copyErr := io.Copy(inputFile, reader)
	closeErr := inputFile.Close()
	if copyErr != nil || closeErr != nil {
		return w.failTimelineTask(task, "深度处理失败", "读取输入视频失败")
	}
	outputDir := filepath.Join(workDir, "output")
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return w.failTimelineTask(task, "深度处理失败", "无法准备输出目录")
	}
	if err := w.progress(task, "加载深度模型", 15); err != nil {
		return err
	}
	if choice.Device == "cpu" {
		if err := w.progress(task, "使用 CPU 处理，可能耗时较长", 15); err != nil {
			return err
		}
	}
	runErr := w.runDepthCommand(ctx, task, python, toolDir, modelRuntime, choice.Device, inputPath, outputDir)
	if shouldRetryDepthOnCPU(runErr, ctx.Err(), 0) && choice.Device == "cuda" {
		choice = depthDeviceChoice{Variant: "cpu", Device: "cpu", FallbackReason: runErr.Error()}
		if err := w.progress(task, "CUDA 设备故障，改用 CPU（可能耗时较长）", 15); err != nil {
			return err
		}
		python, toolDir, modelRuntime, err = w.resolveDepthRuntime(ctx, task, platform, "cpu")
		if err != nil {
			return w.failTimelineTask(task, "深度组件不可用", err.Error())
		}
		if err := os.RemoveAll(outputDir); err != nil {
			return w.failTimelineTask(task, "深度处理失败", "无法清理未完成的 CUDA 输出")
		}
		if err := os.MkdirAll(outputDir, 0o700); err != nil {
			return w.failTimelineTask(task, "深度处理失败", "无法重新准备输出目录")
		}
		runErr = w.runDepthCommand(ctx, task, python, toolDir, modelRuntime, "cpu", inputPath, outputDir)
	}
	if runErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return w.failTimelineTask(task, "深度处理失败", truncateRunes(runErr.Error(), 800))
	}
	matches, _ := filepath.Glob(filepath.Join(outputDir, "*_depth_preview.mp4"))
	if len(matches) != 1 {
		return w.failTimelineTask(task, "输出校验失败", "深度处理组件没有生成有效的视频文件")
	}
	if err := w.progress(task, "保存到素材库", 92); err != nil {
		return err
	}
	file, err := os.Open(matches[0])
	if err != nil {
		return w.failTimelineTask(task, "输出校验失败", "无法读取生成的视频文件")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return w.failTimelineTask(task, "输出校验失败", "生成的视频文件为空")
	}
	stored, err := w.service.UploadLocalResourceFile(task.UserID, "depth-action-reference.mp4", info.Size(), "video", 1920, 1080, resource.DurationMs, file, "depth:"+task.ID)
	if err != nil {
		return w.failTimelineTask(task, "保存结果失败", err.Error())
	}
	result := depthCaptureResult{ResourceID: stored.ID, FileName: "depth-action-reference.mp4", Size: stored.Size, DurationMs: stored.DurationMs, Width: 1920, Height: 1080, Device: choice.Device, FallbackReason: choice.FallbackReason, RuntimeVersion: "v1", ProcessingMs: time.Since(started).Milliseconds()}
	payload, _ := json.Marshal(result)
	task.Status = model.TaskStatusSucceeded
	task.Stage = "已完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := w.service.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入深度处理完成态失败: %w", err)
	}
	return nil
}

func depthWorkerEnv(toolDir string) []string {
	return depthWorkerEnvForPlatform(toolDir, runtime.GOOS)
}

func depthWorkerEnvForPlatform(toolDir, platform string) []string {
	env := append(os.Environ(), "PYTORCH_ENABLE_MPS_FALLBACK=1", "BEEFTV_VDA_SOURCE="+filepath.Join(filepath.Dir(toolDir), "vda"))
	if platform == "windows" {
		env = append(env, "PYTHONIOENCODING=utf-8", "PATH="+filepath.Join(filepath.Dir(toolDir), "bin")+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	return env
}

func depthHasNVIDIACandidate(ctx context.Context) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, "nvidia-smi", "-L").Output()
	return err == nil && strings.TrimSpace(string(output)) != ""
}

func probeDepthCUDA(ctx context.Context, python, toolDir, modelRuntime string) error {
	workDir, err := os.MkdirTemp("", "beeftv-depth-cuda-probe-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)
	command := exec.CommandContext(ctx, python, "-m", "depth_capture.probe", "--device", "cuda", "--runtime-dir", modelRuntime, "--work-dir", workDir)
	command.Dir = toolDir
	command.Env = depthWorkerEnv(toolDir)
	configureDepthCommand(command)
	output, err := command.CombinedOutput()
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("CUDA 真实模型探针失败: %w", classifyDepthWorkerExit(exit.ExitCode(), strings.TrimSpace(string(output))))
	}
	return fmt.Errorf("无法运行 CUDA 真实模型探针: %w", err)
}

func (w *taskWorkerCoordinator) runDepthCommand(ctx context.Context, task *model.Task, python, toolDir, modelRuntime, device, inputPath, outputDir string) error {
	command := exec.CommandContext(ctx, python, "-m", "depth_capture", inputPath,
		"--output-dir", outputDir, "--runtime-dir", modelRuntime, "--device", device,
		"--input-size", "280", "--max-resolution", "960", "--output-resolution", "1920x1080",
		"--max-seconds", "15", "--low-percentile", "2", "--high-percentile", "98", "--gamma", "1.25")
	command.Dir = toolDir
	command.Env = depthWorkerEnv(toolDir)
	configureDepthCommand(command)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("无法启动深度处理组件: %w", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("无法启动深度处理组件: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.Contains(line, "[2/3]"):
			_ = w.progress(task, "分析视频", 35)
		case strings.Contains(line, "[3/3]"):
			_ = w.progress(task, "生成结果视频", 82)
		}
	}
	scanErr := scanner.Err()
	runErr := command.Wait()
	if scanErr != nil && runErr == nil {
		return scanErr
	}
	if runErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = runErr.Error()
		}
		var exit *exec.ExitError
		if errors.As(runErr, &exit) && device == "cuda" {
			return classifyDepthWorkerExit(exit.ExitCode(), message)
		}
		return errors.New(message)
	}
	return nil
}

func (w *taskWorkerCoordinator) resolveDepthRuntime(ctx context.Context, task *model.Task, platform, variant string) (python string, toolDir string, modelRuntime string, err error) {
	python = strings.TrimSpace(os.Getenv(depthPythonEnv))
	toolDir = strings.TrimSpace(os.Getenv(depthToolDirEnv))
	modelRuntime = strings.TrimSpace(os.Getenv(depthRuntimeEnv))
	if python != "" && toolDir != "" && modelRuntime != "" {
		if _, statErr := os.Stat(python); statErr == nil {
			return python, toolDir, modelRuntime, nil
		}
	}
	manifestURL := strings.TrimSpace(os.Getenv(depthManifestEnv))
	if manifestURL == "" {
		if platform == "windows-amd64" {
			manifestURL = defaultWindowsDepthManifestURL
		} else {
			manifestURL = defaultDepthManifestURL
		}
	}
	var publicKey ed25519.PublicKey
	var fallback *depthruntime.Manifest
	if platform == "windows-amd64" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(depthWindowsManifestPublicKeyBase64)
		if decodeErr != nil || len(decoded) != ed25519.PublicKeySize {
			return "", "", "", fmt.Errorf("Windows 深度处理组件尚未配置可信发布公钥，暂不可用")
		}
		publicKey = decoded
	} else {
		fallback = defaultDepthFallbackManifest()
	}
	installation, ensureErr := depthruntime.Ensure(ctx, depthruntime.EnsureOptions{
		ManifestURL:      manifestURL,
		DataDir:          w.service.dataDir,
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
			_ = w.progress(task, stage, taskProgress)
		},
	})
	if ensureErr != nil {
		return "", "", "", ensureErr
	}
	return installation.Python, installation.ToolDir, installation.ModelRuntime, nil
}

func defaultDepthFallbackManifest() *depthruntime.Manifest {
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
