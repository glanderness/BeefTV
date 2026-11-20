package desktopupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

const (
	helperRequestSchema = 1
	atomicTempPrefix    = ".result-"
	atomicTempSuffix    = ".tmp"
	abortedMarkerName   = "aborted"
)

var (
	acquireParentExitWait = openParentExitWait
	errInstallLockBusy    = errors.New("已有更新正在安装")
	preparedMarkerContent = []byte("ok\n")
)

type HelperRequest struct {
	DataDir           string `json:"dataDir,omitempty"`
	WebViewProfileDir string `json:"webViewProfileDir,omitempty"`
	Schema            int    `json:"schema"`
	ParentPID         int    `json:"parentPid"`
	Platform          string `json:"platform"`
	TargetPath        string `json:"targetPath"`
	StagedPath        string `json:"stagedPath"`
	BackupPath        string `json:"backupPath"`
	PreparedPath      string `json:"preparedPath"`
	ResultPath        string `json:"resultPath"`
	WaitTimeoutSec    int    `json:"waitTimeoutSec"`
}

type RecoveryState struct {
	Status        string                     `json:"status"`
	Phase         string                     `json:"phase"`
	FailureStep   string                     `json:"failureStep,omitempty"`
	FailureReason kernel.UpdateFailureReason `json:"failureReason,omitempty"`
	Error         string                     `json:"error,omitempty"`
	ErrorCode     uint32                     `json:"errorCode,omitempty"`
	BackupPath    string                     `json:"backupPath,omitempty"`
	Restored      bool                       `json:"restored"`
	Launched      bool                       `json:"launched"`
	ParentExited  bool                       `json:"parentExited"`
}

func HandleHelperCommand(args []string) (bool, error) {
	requestPath, found := helperRequestArg(args)
	if !found {
		return false, nil
	}
	if requestPath == "" {
		return true, wrapPrepError(prepStepWriteRequest, fmt.Errorf("缺少更新请求文件"))
	}
	return true, RunHelperRequestFile(requestPath)
}

func helperRequestArg(args []string) (string, bool) {
	for i, arg := range args {
		if arg == helperFlag {
			if i+1 >= len(args) {
				return "", true
			}
			return args[i+1], true
		}
	}
	return "", false
}

func RunHelperRequestFile(requestPath string) error {
	data, err := os.ReadFile(requestPath)
	if err != nil {
		return wrapPrepError(prepStepWriteRequest, fmt.Errorf("读取更新请求失败: %w", err))
	}
	var req HelperRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return wrapPrepError(prepStepWriteRequest, fmt.Errorf("更新请求无效"))
	}
	return RunHelperRequest(req)
}

func writeAtomicFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, atomicTempPrefix+"*"+atomicTempSuffix)
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(tmpPath, perm)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	cleanupTmp = false
	return nil
}

func RunHelperRequest(req HelperRequest) error {
	result := RecoveryState{Status: "failed", Phase: "validate", BackupPath: req.BackupPath}
	writeRecovery := func() error {
		if req.ResultPath == "" {
			return nil
		}
		data, err := json.Marshal(result)
		if err != nil {
			return err
		}
		return writeAtomicFile(req.ResultPath, data, 0o600)
	}
	var releaseLock func()
	defer func() {
		if result.Error != "" && result.Status != "rolled_back" {
			result.Status = "failed"
		}
		// Startup cleanup must see the final record before it can take the lock.
		_ = writeRecovery()
		if releaseLock != nil {
			releaseLock()
		}
	}()

	fail := func(step string, err error) error {
		var pe *prepError
		if errors.As(err, &pe) {
			if pe.step != "" {
				result.FailureStep = pe.step
			} else {
				result.FailureStep = step
			}
			result.FailureReason = pe.reason
			if pe.hasErrno {
				result.ErrorCode = pe.errno
			}
			if pe.err != nil {
				result.Error = pe.err.Error()
			} else {
				result.Error = pe.Error()
			}
			return err
		}
		wrapped := wrapPrepError(step, err)
		if errors.As(wrapped, &pe) {
			result.FailureStep = pe.step
			result.FailureReason = pe.reason
			if pe.hasErrno {
				result.ErrorCode = pe.errno
			}
		} else {
			result.FailureStep = step
		}
		if errors.Is(err, errInstallLockBusy) {
			result.Error = errInstallLockBusy.Error()
		} else {
			result.Error = err.Error()
		}
		return wrapped
	}

	if err := validateHelperRequest(req); err != nil {
		return fail(prepStepWriteRequest, err)
	}
	unlock, err := lockInstall(filepath.Join(filepath.Dir(req.TargetPath), ".BeefTV.update.lock"))
	if err != nil {
		return fail(prepStepStage, err)
	}
	releaseLock = unlock
	// Acquire/probe parent exit observation before writing the prepared marker so
	// OpenProcess / signal failures abort preparation before the parent quits.
	waitParent, closeParentWait, err := acquireParentExitWait(req.ParentPID)
	if err != nil {
		return fail(prepStepWaitPrepared, err)
	}
	defer closeParentWait()
	result.Status = "prepared"
	result.Phase = "wait_parent"
	if err := writeRecovery(); err != nil {
		return fail(prepStepWriteRequest, err)
	}
	if isHelperAborted(req) {
		return fail(prepStepWaitPrepared, fmt.Errorf("更新准备已取消"))
	}
	if req.PreparedPath != "" {
		if err := writeAtomicFile(req.PreparedPath, preparedMarkerContent, 0o600); err != nil {
			_ = os.Remove(req.PreparedPath)
			return fail(prepStepWriteRequest, err)
		}
	}

	timeout := time.Duration(req.WaitTimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	if err := waitParent(timeout); err != nil {
		return fail(prepStepWaitPrepared, err)
	}
	waitPlatformWebViewReleased(req.WebViewProfileDir)
	if isHelperAborted(req) {
		return fail(prepStepWaitPrepared, fmt.Errorf("更新准备已取消"))
	}
	result.ParentExited = true
	result.Phase = "replace"
	_ = writeRecovery()

	if err := SwapInstall(req); err != nil {
		wrapped := fail(prepStepStage, err)
		if restoreErr := RestoreBackup(req); restoreErr == nil && pathExists(req.TargetPath) {
			result.Restored = true
			result.Status = "rolled_back"
			result.Launched = relaunchInstall(req) == nil
		}
		return wrapped
	}
	result.Phase = "launch"
	_ = writeRecovery()
	if err := relaunchInstall(req); err != nil {
		wrapped := fail(prepStepStartHelper, err)
		if restoreErr := RestoreBackup(req); restoreErr == nil && pathExists(req.TargetPath) {
			result.Restored = true
			result.Status = "rolled_back"
			_ = relaunchInstall(req)
		}
		return wrapped
	}
	result.Launched = true
	result.Status = "launched"
	result.Phase = "done"
	// Retain recovery files: process creation is not proof of healthy startup.
	return nil
}

func validateHelperRequest(req HelperRequest) error {
	if req.Schema != helperRequestSchema {
		return wrapPrepError(prepStepWriteRequest, fmt.Errorf("更新请求版本不支持"))
	}
	if req.ParentPID <= 0 {
		return wrapPrepError(prepStepWriteRequest, fmt.Errorf("更新请求缺少进程信息"))
	}
	if !filepath.IsAbs(req.TargetPath) || !filepath.IsAbs(req.StagedPath) || !filepath.IsAbs(req.BackupPath) {
		return wrapPrepError(prepStepWriteRequest, fmt.Errorf("更新路径无效"))
	}
	if err := validateExtractedLayout(req.StagedPath, req.Platform); err != nil {
		return wrapPrepError(prepStepValidateLayout, err)
	}
	switch {
	case strings.HasPrefix(req.Platform, "darwin"):
		if filepath.Base(req.TargetPath) != appBundleName {
			return wrapPrepError(prepStepWriteRequest, fmt.Errorf("当前应用包名称不支持自动更新"))
		}
	case strings.HasPrefix(req.Platform, "windows"):
		if filepath.Base(req.TargetPath) != windowsExeName {
			return wrapPrepError(prepStepWriteRequest, fmt.Errorf("当前应用名称不支持自动更新"))
		}
	case req.Platform == "linux-amd64":
		if filepath.Base(req.TargetPath) != linuxBundleName {
			return wrapPrepError(prepStepWriteRequest, fmt.Errorf("当前应用包名称不支持自动更新"))
		}
	default:
		return wrapPrepError(prepStepWriteRequest, ErrUnsupported)
	}
	return nil
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func isHelperAborted(req HelperRequest) bool {
	if req.ResultPath == "" {
		return false
	}
	info, err := os.Lstat(filepath.Join(filepath.Dir(req.ResultPath), abortedMarkerName))
	return err == nil && info.Mode().IsRegular()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	perm := info.Mode().Perm()
	if perm == 0 {
		perm = 0o755
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
