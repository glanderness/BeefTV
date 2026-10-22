package depthruntime

import (
	"archive/zip"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Only the signed v3 Windows CUDA channel may split these fixed interpreter-
// compatible dependencies out of its otherwise complete runtime archive.
type Wheel struct {
	Name         string   `json:"name"`
	URLs         []string `json:"urls"`
	Size         int64    `json:"size"`
	SHA256       string   `json:"sha256"`
	Files        int      `json:"files"`
	ExpandedSize int64    `json:"expandedSize"`
}

var cudaWheelName = regexp.MustCompile(`^(torch|torchvision)-([0-9]+\.[0-9]+\.[0-9]+\+cu128)-cp311-cp311-win_amd64\.whl$`)

func (w Wheel) artifact() Artifact {
	return Artifact{URLs: w.URLs, Size: w.Size, SHA256: w.SHA256, Files: w.Files, ExpandedSize: w.ExpandedSize}
}

func validateWheels(version int, platform string, wheels []Wheel) error {
	if len(wheels) == 0 {
		return nil
	}
	if version != 3 || platform != "windows-amd64/cuda" || len(wheels) != 2 {
		return errors.New("独立依赖只支持新版 Windows CUDA 运行包")
	}
	packages := map[string]bool{}
	var expanded, compressed int64
	for _, wheel := range wheels {
		match := cudaWheelName.FindStringSubmatch(wheel.Name)
		digest, err := hex.DecodeString(wheel.SHA256)
		if match == nil || packages[match[1]] || err != nil || len(digest) != 32 || wheel.Size <= 0 || wheel.Size > 5<<30 || wheel.Files <= 0 || wheel.Files > 50_000 || wheel.ExpandedSize <= 0 || wheel.ExpandedSize > 12<<30 || len(wheel.URLs) == 0 || len(wheel.URLs) > 4 {
			return errors.New("独立依赖的名称、哈希或体积无效")
		}
		packages[match[1]] = true
		for _, source := range wheel.URLs {
			u, err := url.Parse(source)
			if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || filepath.Base(u.Path) != wheel.Name {
				return errors.New("独立依赖下载地址无效")
			}
		}
		compressed += wheel.Size
		expanded += wheel.ExpandedSize
	}
	if compressed > 6<<30 || expanded > 12<<30 {
		return errors.New("独立依赖总体积超过限制")
	}
	return nil
}

func artifactPaths(paths runtimePaths, artifact Artifact) runtimePaths {
	if len(artifact.Wheels) > 0 {
		paths.Archive = filepath.Join(filepath.Dir(paths.Archive), "depth-runtime-v3-windows-amd64-cuda-base.zip")
	}
	return paths
}

func wheelPath(dataDir string, wheel Wheel) string {
	return filepath.Join(dataDir, "downloads", "depth-wheels", wheel.Name)
}

func downloadWheels(ctx context.Context, dataDir string, wheels []Wheel, progress func(string, Progress)) error {
	for _, wheel := range wheels {
		path := wheelPath(dataDir, wheel)
		if verifyFileContext(ctx, path, wheel.artifact()) == nil {
			continue
		}
		if err := Download(ctx, wheel.artifact(), path, componentProgress(progress, wheel.Name)); err != nil {
			return fmt.Errorf("下载深度运行依赖失败: %w", err)
		}
	}
	return nil
}

type wheelPython func(context.Context, string, string, []string) error

func installWheels(ctx context.Context, dataDir, stage string, wheels []Wheel, run wheelPython) error {
	if len(wheels) == 0 {
		return nil
	}
	var err error
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	stage, err = filepath.Abs(stage)
	if err != nil {
		return err
	}
	// Verify every file before running even the trusted bundled interpreter.
	args := []string{"-I", "-X", "utf8", "-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--no-index", "--no-deps", "--no-cache-dir", "--no-compile", "--no-warn-script-location", "--only-binary=:all:", "--target", pythonFilesystemPath(filepath.Join(stage, ".python", "Lib", "site-packages"))}
	versions := map[string]string{}
	for _, wheel := range wheels {
		path := wheelPath(dataDir, wheel)
		if err := verifyFileContext(ctx, path, wheel.artifact()); err != nil {
			return fmt.Errorf("依赖执行前完整校验失败: %w", err)
		}
		if err := inspectWheel(path, wheel); err != nil {
			return err
		}
		args = append(args, pythonFilesystemPath(path))
		match := cudaWheelName.FindStringSubmatch(wheel.Name)
		if match == nil {
			return errors.New("依赖文件名不支持当前 Python")
		}
		versions[match[1]] = match[2]
	}
	python := filepath.Join(stage, ".python", "python.exe")
	if err := run(ctx, python, stage, args); err != nil {
		return fmt.Errorf("安装深度运行依赖失败: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// This verifies DLL loading and the paired versions without requiring a GPU.
	check := `import sys, torch, torchvision, cv2, numpy; assert sys.flags.utf8_mode == 1; assert sys.stdout.encoding.lower().replace('-', '') == 'utf8'; assert torch.__version__ == sys.argv[1]; assert torchvision.__version__ == sys.argv[2]; assert torch.version.cuda == '12.8'; assert torch.ones(1).add(1).item() == 2`
	if err := run(ctx, python, stage, []string{"-I", "-X", "utf8", "-c", check, versions["torch"], versions["torchvision"]}); err != nil {
		return fmt.Errorf("深度运行依赖安装自检失败: %w", err)
	}
	return nil
}

func inspectWheel(path string, wheel Wheel) error {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("打开依赖文件失败: %w", err)
	}
	defer reader.Close()
	var expanded int64
	for _, entry := range reader.File {
		name := strings.ReplaceAll(entry.Name, `\`, "/")
		clean := filepath.Clean(filepath.FromSlash(name))
		if strings.Contains(name, ":") || strings.HasPrefix(name, "/") || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || entry.Mode()&os.ModeSymlink != 0 || entry.UncompressedSize64 > 12<<30 {
			return errors.New("依赖文件包含非安全路径或体积")
		}
		expanded += int64(entry.UncompressedSize64)
		if expanded > 12<<30 {
			return errors.New("依赖解压体积超过限制")
		}
	}
	return validateArchiveShape(len(reader.File), expanded, wheel.artifact(), 12<<30)
}

func runWheelPython(ctx context.Context, python, stage string, args []string) error {
	temporary := filepath.Join(stage, ".pip-tmp")
	if err := os.MkdirAll(temporary, 0700); err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	command := exec.CommandContext(ctx, python, args...)
	command.Dir = stage
	for _, variable := range os.Environ() {
		name, _, _ := strings.Cut(variable, "=")
		switch strings.ToUpper(name) {
		case "PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE", "PYTHONUTF8", "PYTHONIOENCODING", "PIP_CONFIG_FILE", "TEMP", "TMP":
			continue
		}
		command.Env = append(command.Env, variable)
	}
	command.Env = append(command.Env, "TEMP="+pythonFilesystemPath(temporary), "TMP="+pythonFilesystemPath(temporary), "PIP_CONFIG_FILE="+os.DevNull)
	ConfigurePythonCommand(command)
	command.WaitDelay = 5 * time.Second
	// pip can print a line per file on failure; bound retained output separately
	// from the process, while still draining its stdout/stderr.
	output := &limitedOutput{}
	command.Stdout, command.Stderr = output, output
	err := runPythonProcess(command)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("Python 安装或自检失败: %w: %s", err, output.text)
	}
	return nil
}

type limitedOutput struct{ text string }

func (w *limitedOutput) Write(p []byte) (int, error) {
	w.text += string(p)
	if len(w.text) > 8192 {
		w.text = w.text[len(w.text)-8192:]
	}
	return len(p), nil
}
