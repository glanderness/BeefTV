package desktopupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
)

const (
	helperStartRetryWindow     = 6 * time.Second
	helperStartRetryInitial    = 100 * time.Millisecond
	helperStartRetryMaxBackoff = 500 * time.Millisecond
	helperKillWaitTimeout      = 3 * time.Second
)

func (e *Engine) prepareAndStartHelper(ctx context.Context, staged *stagedUpdate) error {
	started := time.Now()
	var workDir string
	prepared := false
	helperExited := true
	defer func() {
		e.logf("install preparation elapsed=%s", time.Since(started).Round(time.Millisecond))
		if !prepared && workDir != "" {
			e.reclaimAbandonedWorkDir(workDir, helperExited)
		}
	}()
	e.setPhase("verifying")
	target, err := e.locate()
	if err != nil {
		return wrapPrepError(prepStepStage, err)
	}
	if e.dataDir != "" {
		dataDir, err := physicalPath(e.dataDir)
		if err != nil {
			return wrapPrepError(prepStepStage, err)
		}
		installRoot := target.Path
		if strings.HasPrefix(target.Platform, "windows") || strings.HasPrefix(staged.platform, "windows") {
			installRoot = filepath.Dir(target.Path)
		}
		installRoot, err = physicalPath(installRoot)
		if err != nil {
			return wrapPrepError(prepStepStage, err)
		}
		if withinRoot(installRoot, dataDir) || withinRoot(dataDir, installRoot) {
			return wrapPrepError(prepStepStage, fmt.Errorf("数据目录与程序目录重叠，请先将数据移到独立目录"))
		}
	}
	parentPID := e.parentPID
	if parentPID <= 0 {
		parentPID = os.Getpid()
	}
	// Prepare on the target volume before exit, so denied access or disk-full
	// cannot leave a closed application with half-copied replacement files.
	workDir, err = os.MkdirTemp(filepath.Dir(target.Path), ".beeftv-update-*")
	if err != nil {
		return wrapPrepError(prepStepStage, err)
	}
	archive, err := os.Open(staged.archive)
	if err != nil {
		return wrapPrepError(prepStepVerify, err)
	}
	hash := sha256.New()
	n, copyErr := io.Copy(hash, io.LimitReader(contextReader{ctx, archive}, staged.artifact.Size+1))
	_ = archive.Close()
	if ctx.Err() != nil {
		return wrapPrepError(prepStepVerify, ErrPreparationTimeout)
	}
	if copyErr != nil {
		return wrapPrepError(prepStepVerify, copyErr)
	}
	if n != staged.artifact.Size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), staged.artifact.SHA256) {
		return wrapPrepError(prepStepVerify, ErrTampered)
	}
	payloadPath := filepath.Join(workDir, "payload")
	e.setPhase("extracting")
	progressFn := func(completed, total int) {
		e.set(func(state *UpdateState) { state.CompletedFiles, state.TotalFiles = completed, total })
	}
	if staged.isDelta {
		if err := applyDeltaZipWithProgress(ctx, staged.archive, target.Path, staged.platform, payloadPath, defaultExtractLimits(), progressFn); err != nil {
			if ctx.Err() != nil {
				return wrapPrepError(prepStepExtract, ErrPreparationTimeout)
			}
			_ = os.RemoveAll(payloadPath)
			if fallbackErr := e.fallbackExtractFullArchive(ctx, staged, payloadPath, progressFn); fallbackErr != nil {
				if ctx.Err() != nil {
					return wrapPrepError(prepStepExtract, ErrPreparationTimeout)
				}
				e.logf("delta apply failed (%v) and full archive fallback failed: %v", err, fallbackErr)
				return wrapPrepError(prepStepExtract, fallbackErr)
			}
		}
	} else if err := extractSecureZipWithProgress(ctx, staged.archive, payloadPath, defaultExtractLimits(), progressFn); err != nil {
		if ctx.Err() != nil {
			return wrapPrepError(prepStepExtract, ErrPreparationTimeout)
		}
		return wrapPrepError(prepStepExtract, err)
	}
	e.setPhase("preparing")
	if err := validateExtractedLayout(payloadPath, staged.platform); err != nil {
		return wrapPrepError(prepStepValidateLayout, fmt.Errorf("%w: %w", ErrInvalidArchive, err))
	}
	if ctx.Err() != nil {
		return wrapPrepError(prepStepValidateLayout, ErrPreparationTimeout)
	}
	exe, exeErr := os.Executable()
	webViewProfileDir := ""
	if exeErr == nil && sameInstalledExecutable(exe, target.Path) {
		webViewProfileDir = resolvePlatformWebViewProfileDir(target.Path, e.dataDir)
	}
	req := HelperRequest{
		DataDir:           e.dataDir,
		WebViewProfileDir: webViewProfileDir,
		TargetVersion:     staged.version,
		Schema:            helperRequestSchema,
		ParentPID:         parentPID,
		Platform:          staged.platform,
		TargetPath:        target.Path,
		StagedPath:        payloadPath,
		BackupPath:        filepath.Join(workDir, "backup"),
		PreparedPath:      filepath.Join(workDir, "prepared"),
		ResultPath:        filepath.Join(workDir, "result.json"),
		WaitTimeoutSec:    120,
	}
	if e.helper != nil {
		waitTimeout := e.waitPreparedTimeout
		if waitTimeout <= 0 {
			waitTimeout = 5 * time.Second
		}
		waiter := startHelperWaiter(func() error { return e.helper(req) })
		if err := waitForPrepared(ctx, req.PreparedPath, waitTimeout, waiter); err != nil {
			killedExitErr, exited := waiter.Result()
			helperExited = exited
			return wrapWaitPreparedError(err, killedExitErr, req.ResultPath, "")
		}
		prepared = true
		return nil
	}
	requestPath := filepath.Join(workDir, "request.json")
	data, err := json.Marshal(req)
	if err != nil {
		return wrapPrepError(prepStepWriteRequest, err)
	}
	if err := writeAtomicFile(requestPath, data, 0o600); err != nil {
		return wrapPrepError(prepStepWriteRequest, err)
	}
	helperPath := filepath.Join(workDir, helperFileName())
	if exeErr != nil {
		return wrapPrepError(prepStepCopyHelper, exeErr)
	}
	if err := copyFile(exe, helperPath); err != nil {
		return wrapPrepError(prepStepCopyHelper, err)
	}
	if err := os.Chmod(helperPath, 0o755); err != nil && runtime.GOOS != "windows" {
		return wrapPrepError(prepStepCopyHelper, err)
	}
	helperLogPath := filepath.Join(workDir, "helper.log")
	logFile, logErr := os.OpenFile(helperLogPath, os.O_CREATE|os.O_WRONLY, 0o600)
	if logErr != nil {
		e.logf("install helper log unavailable")
	}
	closeLogFile := func() {
		if logFile != nil {
			_ = logFile.Close()
			logFile = nil
		}
	}
	defer closeLogFile()
	cmd, err := startCommandWithRetry(
		ctx,
		func() *exec.Cmd {
			c := exec.Command(helperPath, helperFlag, requestPath)
			c.Dir = workDir
			c.SysProcAttr = detachedSysProcAttr()
			if logErr == nil {
				c.Stdout = logFile
				c.Stderr = logFile
			}
			return c
		},
		(*exec.Cmd).Start,
		isRetryableHelperStartError,
		helperStartRetryWindow,
		helperStartRetryInitial,
		helperStartRetryMaxBackoff,
	)
	closeLogFile()
	if err != nil {
		if ctx.Err() != nil {
			return wrapPrepError(prepStepStartHelper, ErrPreparationTimeout)
		}
		return wrapPrepError(prepStepStartHelper, err)
	}
	waiter := startHelperWaiter(cmd.Wait)
	waitTimeout := e.waitPreparedTimeout
	if waitTimeout <= 0 {
		waitTimeout = 15 * time.Second
	}
	if err := waitForPrepared(ctx, req.PreparedPath, waitTimeout, waiter); err != nil {
		var exited *helperExitedError
		var killedExitErr error
		if !errors.As(err, &exited) {
			killedExitErr, helperExited = terminateHelperWaiter(cmd.Process.Kill, waiter, helperKillWaitTimeout, e.logf)
		}
		return wrapWaitPreparedError(err, killedExitErr, req.ResultPath, helperLogPath)
	}
	e.mu.Lock()
	e.helperProc = cmd.Process
	e.helperWait = waiter
	e.helperWorkDir = workDir
	e.mu.Unlock()
	prepared = true
	return nil
}

func (e *Engine) reclaimAbandonedWorkDir(workDir string, helperExited bool) {
	if workDir == "" || hasRecoveryBackup(filepath.Join(workDir, "backup")) {
		return
	}
	markAborted := func() {
		_ = writeAtomicFile(filepath.Join(workDir, abortedMarkerName), []byte("aborted\n"), 0o600)
	}
	if !helperExited {
		markAborted()
		e.logf("install helper did not exit; update files retained")
		return
	}
	cleanupDir := e.removeWorkDir
	if cleanupDir == nil {
		cleanupDir = os.RemoveAll
	}
	if err := removeWorkDirBestEffort(cleanupDir, workDir); err != nil {
		markAborted()
		e.logf("install update files retained after cleanup failure")
	}
}

// Resolve existing ancestors too: a not-yet-created data directory may sit
// under a symlink (notably /var on macOS).
func physicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(abs)
	if parent == abs {
		return "", err
	}
	resolved, err = physicalPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(abs)), nil
}

func helperFileName() string {
	if runtime.GOOS == "windows" {
		return "BeefTV-update-helper.exe"
	}
	return "BeefTV-update-helper"
}

func sameInstalledExecutable(runningExe, targetPath string) bool {
	if strings.TrimSpace(runningExe) == "" || strings.TrimSpace(targetPath) == "" {
		return false
	}
	p1, err1 := physicalPath(runningExe)
	p2, err2 := physicalPath(targetPath)
	if err1 != nil || err2 != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(p1, p2)
	}
	return p1 == p2
}

func startCommandWithRetry(
	ctx context.Context,
	buildCmd func() *exec.Cmd,
	start func(*exec.Cmd) error,
	isRetryable func(error) bool,
	window time.Duration,
	initialBackoff time.Duration,
	maxBackoff time.Duration,
) (*exec.Cmd, error) {
	deadline := time.Now().Add(window)
	backoff := initialBackoff
	if backoff <= 0 {
		backoff = 10 * time.Millisecond
	}
	if maxBackoff < backoff {
		maxBackoff = backoff
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		cmd := buildCmd()
		err := start(cmd)
		if err == nil {
			return cmd, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if isRetryable == nil || !isRetryable(err) {
			return nil, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, err
		}
		wait := backoff
		if wait > remaining {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// helperWaiter broadcasts a single cmd.Wait/helper completion to any number of
// observers without consuming or re-injecting a channel element.
type helperWaiter struct {
	done chan struct{}
	err  error
}

func startHelperWaiter(wait func() error) *helperWaiter {
	w := &helperWaiter{done: make(chan struct{})}
	go func() {
		w.err = wait()
		close(w.done)
	}()
	return w
}

func (w *helperWaiter) Done() <-chan struct{} {
	if w == nil {
		return nil
	}
	return w.done
}

func (w *helperWaiter) Result() (error, bool) {
	if w == nil {
		return nil, false
	}
	select {
	case <-w.done:
		return w.err, true
	default:
		return nil, false
	}
}

func (w *helperWaiter) Wait() error {
	if w == nil {
		return nil
	}
	<-w.done
	return w.err
}

func (w *helperWaiter) WaitTimeout(timeout time.Duration) (error, bool) {
	if w == nil {
		return nil, true
	}
	select {
	case <-w.done:
		return w.err, true
	default:
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-w.done:
		return w.err, true
	case <-timer.C:
		return nil, false
	}
}

func terminateHelperWaiter(kill func() error, waiter *helperWaiter, timeout time.Duration, logf func(string, ...any)) (error, bool) {
	if kill != nil {
		if err := kill(); err != nil && !errors.Is(err, os.ErrProcessDone) && logf != nil {
			logf("install helper kill failed: %v", err)
		}
	}
	return waiter.WaitTimeout(timeout)
}

func preparedMarkerReady(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(len(preparedMarkerContent)+1)))
	if err != nil {
		return false
	}
	return bytes.Equal(data, preparedMarkerContent)
}

func removeWorkDirBestEffort(remove func(string) error, dir string) error {
	attempts := 1
	if runtime.GOOS == "windows" {
		attempts = 10
	}
	var lastErr error
	for i := 0; i < attempts; i++ {
		if err := remove(dir); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if i+1 < attempts {
			time.Sleep(50 * time.Millisecond)
		}
	}
	return lastErr
}

func waitForPrepared(ctx context.Context, path string, timeout time.Duration, waiter *helperWaiter) error {
	handleExit := func(exitErr error) error {
		if exitErr == nil && preparedMarkerReady(path) {
			return nil
		}
		return &helperExitedError{err: exitErr}
	}
	preparedNow := func() (bool, error) {
		if !preparedMarkerReady(path) {
			return false, nil
		}
		if exitErr, exited := waiter.Result(); exited {
			return true, handleExit(exitErr)
		}
		return true, nil
	}
	if exitErr, exited := waiter.Result(); exited {
		return handleExit(exitErr)
	}
	if ready, err := preparedNow(); ready {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %w", ErrPreparationTimeout, err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-waiter.Done():
			return handleExit(waiter.err)
		case <-ctx.Done():
			if exitErr, exited := waiter.Result(); exited {
				return handleExit(exitErr)
			}
			if ready, err := preparedNow(); ready {
				return err
			}
			return fmt.Errorf("%w: %w", ErrPreparationTimeout, ctx.Err())
		case <-timer.C:
			if exitErr, exited := waiter.Result(); exited {
				return handleExit(exitErr)
			}
			if ready, err := preparedNow(); ready {
				return err
			}
			return ErrPreparationTimeout
		case <-ticker.C:
			if ready, err := preparedNow(); ready {
				return err
			}
		}
	}
}

func (e *Engine) fallbackExtractFullArchive(ctx context.Context, staged *stagedUpdate, payloadPath string, progress func(int, int)) error {
	e.mu.Lock()
	verified := e.verified
	e.mu.Unlock()
	if verified == nil || verified.payload.Version != staged.version || len(verified.artifact.CandidateURLs()) == 0 {
		return fmt.Errorf("no full archive fallback available")
	}
	e.logf("delta apply failed during install; downloading full archive for %s", staged.version)
	fullZip := filepath.Join(filepath.Dir(staged.archive), "update.zip")
	if err := e.downloadArchive(ctx, verified.artifact, fullZip); err != nil {
		return err
	}
	return extractSecureZipWithProgress(ctx, fullZip, payloadPath, defaultExtractLimits(), progress)
}
