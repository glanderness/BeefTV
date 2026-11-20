package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

func TestStartCommandWithRetryBehavior(t *testing.T) {
	transientErr := errors.New("transient sharing lock")
	fatalErr := errors.New("permanent exec error")

	t.Run("succeeds-on-retry-with-fresh-cmd", func(t *testing.T) {
		seen := make(map[*exec.Cmd]bool)
		attempts := 0
		cmd, err := startCommandWithRetry(
			context.Background(),
			func() *exec.Cmd { return exec.Command("helper") },
			func(c *exec.Cmd) error {
				if seen[c] {
					t.Fatal("reused *exec.Cmd across retry attempts")
				}
				seen[c] = true
				attempts++
				if attempts < 3 {
					return transientErr
				}
				return nil
			},
			func(err error) bool { return errors.Is(err, transientErr) },
			300*time.Millisecond,
			5*time.Millisecond,
			20*time.Millisecond,
		)
		if err != nil || cmd == nil || attempts != 3 {
			t.Fatalf("cmd=%v err=%v attempts=%d", cmd, err, attempts)
		}
	})

	t.Run("stops-immediately-on-non-retryable", func(t *testing.T) {
		attempts := 0
		cmd, err := startCommandWithRetry(
			context.Background(),
			func() *exec.Cmd { return exec.Command("helper") },
			func(*exec.Cmd) error {
				attempts++
				return fatalErr
			},
			func(err error) bool { return errors.Is(err, transientErr) },
			300*time.Millisecond,
			5*time.Millisecond,
			20*time.Millisecond,
		)
		if cmd != nil || !errors.Is(err, fatalErr) || attempts != 1 {
			t.Fatalf("cmd=%v err=%v attempts=%d", cmd, err, attempts)
		}
	})

	t.Run("stops-promptly-on-context-cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		attempts := 0
		started := time.Now()
		cmd, err := startCommandWithRetry(
			ctx,
			func() *exec.Cmd { return exec.Command("helper") },
			func(*exec.Cmd) error {
				attempts++
				go func() {
					time.Sleep(15 * time.Millisecond)
					cancel()
				}()
				return transientErr
			},
			func(err error) bool { return errors.Is(err, transientErr) },
			5*time.Second,
			2*time.Second,
			2*time.Second,
		)
		elapsed := time.Since(started)
		if cmd != nil || !errors.Is(err, context.Canceled) || attempts != 1 || elapsed > 500*time.Millisecond {
			t.Fatalf("cmd=%v err=%v attempts=%d elapsed=%s", cmd, err, attempts, elapsed)
		}
	})

	t.Run("returns-last-error-when-window-exhausted", func(t *testing.T) {
		wrapped := &os.PathError{Op: "fork/exec", Path: "/tmp/helper", Err: syscall.EACCES}
		attempts := 0
		cmd, err := startCommandWithRetry(
			context.Background(),
			func() *exec.Cmd { return exec.Command("helper") },
			func(*exec.Cmd) error {
				attempts++
				return wrapped
			},
			func(error) bool { return true },
			35*time.Millisecond,
			10*time.Millisecond,
			15*time.Millisecond,
		)
		if cmd != nil || !errors.Is(err, syscall.EACCES) || attempts < 2 {
			t.Fatalf("cmd=%v err=%v attempts=%d", cmd, err, attempts)
		}
	})
}

func TestWaitForPreparedEarlyExitTimeoutAndRace(t *testing.T) {
	t.Run("fails-fast-on-early-exit", func(t *testing.T) {
		exitErr := errors.New("helper crashed")
		waiter := startHelperWaiter(func() error {
			time.Sleep(15 * time.Millisecond)
			return exitErr
		})
		started := time.Now()
		err := waitForPrepared(context.Background(), filepath.Join(t.TempDir(), "prepared"), 5*time.Second, waiter)
		elapsed := time.Since(started)
		var exited *helperExitedError
		if !errors.As(err, &exited) || !errors.Is(err, exitErr) || elapsed > time.Second {
			t.Fatalf("err=%v elapsed=%s", err, elapsed)
		}
	})

	t.Run("timeout-wraps-ErrPreparationTimeout", func(t *testing.T) {
		unblock := make(chan struct{})
		defer close(unblock)
		waiter := startHelperWaiter(func() error {
			<-unblock
			return nil
		})
		err := waitForPrepared(context.Background(), filepath.Join(t.TempDir(), "prepared"), 40*time.Millisecond, waiter)
		if !errors.Is(err, ErrPreparationTimeout) {
			t.Fatalf("expected ErrPreparationTimeout, got %v", err)
		}
	})

	t.Run("prepared-then-nil-exit-succeeds-and-remains-observable", func(t *testing.T) {
		preparedPath := filepath.Join(t.TempDir(), "prepared")
		waiter := startHelperWaiter(func() error {
			time.Sleep(10 * time.Millisecond)
			_ = os.WriteFile(preparedPath, []byte("ok\n"), 0o600)
			return nil
		})
		if err := waitForPrepared(context.Background(), preparedPath, time.Second, waiter); err != nil {
			t.Fatalf("expected nil when prepared was created and helper exited cleanly, got %v", err)
		}
		if err, exited := waiter.Result(); !exited || err != nil {
			t.Fatalf("waiter.Result() = (%v, %t), want (nil, true)", err, exited)
		}
		if err := waiter.Wait(); err != nil {
			t.Fatalf("waiter.Wait() = %v, want nil", err)
		}
	})

	t.Run("prepared-with-error-exit-fails-before-quit", func(t *testing.T) {
		preparedPath := filepath.Join(t.TempDir(), "prepared")
		sentinel := errors.New("waitForPID failed")
		if err := os.WriteFile(preparedPath, []byte("ok\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		waiter := startHelperWaiter(func() error { return sentinel })
		<-waiter.Done()
		err := waitForPrepared(context.Background(), preparedPath, time.Second, waiter)
		var exited *helperExitedError
		if !errors.As(err, &exited) || !errors.Is(err, sentinel) {
			t.Fatalf("expected helperExitedError wrapping sentinel, got %v", err)
		}
	})

	t.Run("timer-expiry-prioritizes-ready-exit-error", func(t *testing.T) {
		sentinel := errors.New("helper failed at deadline")
		waiter := startHelperWaiter(func() error { return sentinel })
		<-waiter.Done()
		err := waitForPrepared(context.Background(), filepath.Join(t.TempDir(), "prepared"), 0, waiter)
		var exited *helperExitedError
		if !errors.As(err, &exited) || !errors.Is(err, sentinel) {
			t.Fatalf("expected helperExitedError over timeout, got %v", err)
		}
	})

	t.Run("canceled-context-honors-written-prepared", func(t *testing.T) {
		unblock := make(chan struct{})
		defer close(unblock)
		waiter := startHelperWaiter(func() error {
			<-unblock
			return nil
		})
		// Case 1: prepared exists before entry with already-canceled context.
		prePath := filepath.Join(t.TempDir(), "prepared-pre")
		if err := os.WriteFile(prePath, []byte("ok\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		preCtx, preCancel := context.WithCancel(context.Background())
		preCancel()
		if err := waitForPrepared(preCtx, prePath, time.Second, waiter); err != nil {
			t.Fatalf("expected nil when prepared already exists on canceled ctx, got %v", err)
		}
		// Case 2: prepared written in-loop right before context cancels (before 20ms poll tick).
		inLoopPath := filepath.Join(t.TempDir(), "prepared-loop")
		loopCtx, loopCancel := context.WithCancel(context.Background())
		defer loopCancel()
		go func() {
			time.Sleep(5 * time.Millisecond)
			_ = os.WriteFile(inLoopPath, []byte("ok\n"), 0o600)
			loopCancel()
		}()
		if err := waitForPrepared(loopCtx, inLoopPath, time.Second, waiter); err != nil {
			t.Fatalf("expected nil when prepared was written right before cancel, got %v", err)
		}
	})

	t.Run("ignores-empty-and-partial-prepared-marker", func(t *testing.T) {
		unblock := make(chan struct{})
		defer close(unblock)
		waiter := startHelperWaiter(func() error {
			<-unblock
			return nil
		})
		for name, body := range map[string][]byte{"empty": nil, "partial": []byte("o")} {
			p := filepath.Join(t.TempDir(), "prepared-"+name)
			if err := os.WriteFile(p, body, 0o600); err != nil {
				t.Fatal(err)
			}
			err := waitForPrepared(context.Background(), p, 40*time.Millisecond, waiter)
			if !errors.Is(err, ErrPreparationTimeout) {
				t.Fatalf("%s marker should not be accepted as prepared, got %v", name, err)
			}
		}
	})
}

func TestTerminateHelperWaiterBoundsUnkillableHelper(t *testing.T) {
	unblock := make(chan struct{})
	defer close(unblock)
	waiter := startHelperWaiter(func() error {
		<-unblock
		return nil
	})
	var logged string
	started := time.Now()
	exitErr, exited := terminateHelperWaiter(
		func() error { return os.ErrPermission },
		waiter,
		40*time.Millisecond,
		func(format string, args ...any) { logged = fmt.Sprintf(format, args...) },
	)
	elapsed := time.Since(started)
	if exited || exitErr != nil || elapsed > time.Second {
		t.Fatalf("exitErr=%v exited=%t elapsed=%s", exitErr, exited, elapsed)
	}
	if !strings.Contains(logged, "install helper kill failed:") {
		t.Fatalf("missing kill failure log: %q", logged)
	}
}

func TestPreparationElapsedLoggedBeforeWorkDirCleanup(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	archive := writeRawZip(t, t.TempDir(), "bad.zip", map[string][]byte{"unexpected.txt": []byte("bad")})
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	logPath := filepath.Join(t.TempDir(), "update.log")

	var mu sync.Mutex
	cleanupCalls := 0
	countBeforeCleanup := -1
	engine := &Engine{
		enabled:        true,
		currentVersion: "v2.3.2",
		logPath:        logPath,
		staged: &stagedUpdate{
			archive:  archive,
			platform: "darwin-arm64",
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: filepath.Join(root, appBundleName), Platform: "darwin-arm64"}, nil
		},
		removeWorkDir: func(dir string) error {
			raw, _ := os.ReadFile(logPath)
			mu.Lock()
			if cleanupCalls == 0 {
				countBeforeCleanup = strings.Count(string(raw), "install preparation elapsed=")
			}
			cleanupCalls++
			mu.Unlock()
			return os.RemoveAll(dir)
		},
	}

	if err := engine.InstallUpdate(context.Background()); err == nil {
		t.Fatal("expected layout failure")
	}
	mu.Lock()
	calls, before := cleanupCalls, countBeforeCleanup
	mu.Unlock()
	if calls == 0 || before != 1 {
		t.Fatalf("cleanupCalls=%d countBeforeCleanup=%d", calls, before)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	logText := string(raw)
	if strings.Count(logText, "install preparation elapsed=") != 1 {
		t.Fatalf("unexpected elapsed line count:\n%s", logText)
	}
	if !strings.Contains(logText, "install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=validate_layout reason=invalid_archive") {
		t.Fatalf("missing structured validate_layout metadata in log:\n%s", logText)
	}
}

func writeNativeSubprocessFixture(t *testing.T, root string) (platform, targetPath, archive string, archiveData []byte) {
	t.Helper()
	var files map[string][]byte
	var execFiles map[string]bool
	if runtime.GOOS == "windows" {
		if err := WriteWindowsLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		files, execFiles = WindowsZipFiles("NEW")
		platform = "windows-amd64"
		targetPath = filepath.Join(root, windowsExeName)
	} else {
		if err := WriteDarwinLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		files, execFiles = DarwinZipFiles("NEW")
		platform = "darwin-arm64"
		targetPath = filepath.Join(root, appBundleName)
	}
	archive = filepath.Join(t.TempDir(), "update.zip")
	if err := WriteZip(archive, files, execFiles); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	return platform, targetPath, archive, data
}

func TestInstallUpdateRealSubprocessTimeoutKillsAndCleansUp(t *testing.T) {
	root := t.TempDir()
	platform, targetPath, archive, data := writeNativeSubprocessFixture(t, root)
	sum := sha256.Sum256(data)
	t.Setenv("BEEFTV_UPDATER_TEST_HANG_HELPER", "1")

	logPath := filepath.Join(t.TempDir(), "update.log")
	engine := &Engine{
		enabled:             true,
		currentVersion:      "v2.3.2",
		logPath:             logPath,
		waitPreparedTimeout: 80 * time.Millisecond,
		staged: &stagedUpdate{
			version:  "v2.3.3",
			archive:  archive,
			platform: platform,
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: targetPath, Platform: platform}, nil
		},
	}

	started := time.Now()
	err := engine.InstallUpdate(context.Background())
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("expected timeout failure from hanging helper subprocess")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("timeout + kill + drain took too long: %s", elapsed)
	}
	if state := engine.snapshot(); !strings.Contains(state.Error, "准备安装超时") {
		t.Fatalf("unexpected public timeout error: %+v", state)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "install failure phase=preparing completedFiles=0 totalFiles=0 timeout=true step=wait_prepared reason=timeout") {
		t.Fatalf("missing timeout metadata in log:\n%s", raw)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".beeftv-update-") {
			t.Fatalf("workDir leaked after subprocess kill: %s", entry.Name())
		}
	}
}

func TestInstallUpdateEarlyHelperExitLogsReasonBeforeCleanup(t *testing.T) {
	root := t.TempDir()
	platform, targetPath, archive, data := writeNativeSubprocessFixture(t, root)
	sum := sha256.Sum256(data)

	// Hold the install lock so the real spawned helper exits immediately before creating prepared.
	unlock, err := lockInstall(filepath.Join(root, ".BeefTV.update.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	logPath := filepath.Join(t.TempDir(), "update.log")
	engine := &Engine{
		enabled:        true,
		currentVersion: "v2.3.2",
		logPath:        logPath,
		staged: &stagedUpdate{
			version:  "v2.3.3",
			archive:  archive,
			platform: platform,
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: targetPath, Platform: platform}, nil
		},
	}

	started := time.Now()
	err = engine.InstallUpdate(context.Background())
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("expected install failure when lock is held")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("early helper exit waited too long: %s", elapsed)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	logText := string(raw)
	wantLine := fmt.Sprintf("install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=stage reason=install_locked errno=%d exitCode=1", expectedLockBusyErrno())
	if !strings.Contains(logText, wantLine) {
		t.Fatalf("missing early-exit diagnostic metadata (want %q):\n%s", wantLine, logText)
	}
	if state := engine.snapshot(); !strings.Contains(state.Error, "已有更新正在安装") {
		t.Fatalf("unexpected public install-locked error: %+v", state)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".beeftv-update-") {
			t.Fatalf("workDir was not cleaned up: %s", entry.Name())
		}
	}
}

func TestInstallUpdateRealSubprocessSuccessReplacesAndMonitorsHelper(t *testing.T) {
	root := t.TempDir()
	var (
		files      map[string][]byte
		execFiles  map[string]bool
		platform   string
		targetPath string
		installed  string
	)
	if runtime.GOOS == "windows" {
		if err := WriteWindowsLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		files, execFiles = WindowsZipFiles("NEW")
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		exeBytes, err := os.ReadFile(exe)
		if err != nil {
			t.Fatal(err)
		}
		files[windowsExeName] = exeBytes
		platform = "windows-amd64"
		targetPath = filepath.Join(root, windowsExeName)
		installed = filepath.Join(root, pluginDirName, "official.beeftv-plugin")
		t.Setenv("BEEFTV_UPDATER_TEST_LAUNCH", "1")
	} else {
		if err := WriteDarwinLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		files, execFiles = DarwinZipFiles("NEW")
		platform = "darwin-arm64"
		targetPath = filepath.Join(root, appBundleName)
		installed = filepath.Join(targetPath, "Contents", "MacOS", "BeefTV")
	}
	archive := filepath.Join(t.TempDir(), "update.zip")
	if err := WriteZip(archive, files, execFiles); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)

	quitCalled := false
	logPath := filepath.Join(t.TempDir(), "update.log")
	engine := &Engine{
		enabled:        true,
		currentVersion: "v2.3.2",
		logPath:        logPath,
		parentPID:      unusedPID(t),
		staged: &stagedUpdate{
			version:  "v2.3.3",
			archive:  archive,
			platform: platform,
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: targetPath, Platform: platform}, nil
		},
		quit: func() error {
			quitCalled = true
			return nil
		},
	}

	if err := engine.InstallUpdate(context.Background()); err != nil {
		t.Fatalf("InstallUpdate with real helper failed: %v", err)
	}
	if !quitCalled {
		t.Fatal("expected quit to be requested after helper prepared")
	}
	// monitorHelper must observe helper completion on helperWait and clear Installing
	// when the parent stayed alive in this test.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(logPath)
		if strings.Contains(string(raw), "install helper stopped:") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "install helper stopped:") {
		t.Fatalf("monitorHelper did not observe real helper exit:\n%s", raw)
	}
	got, err := os.ReadFile(installed)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("installed payload = %q, want NEW", got)
	}
}

func TestInstallUpdateWaitPreparedTimeoutLogsTimeoutTrue(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	files, execFiles := DarwinZipFiles("NEW")
	archive := filepath.Join(t.TempDir(), "update.zip")
	if err := WriteZip(archive, files, execFiles); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)

	unblock := make(chan struct{})
	defer close(unblock)
	removeCalls := 0
	logPath := filepath.Join(t.TempDir(), "update.log")
	engine := &Engine{
		enabled:        true,
		currentVersion: "v2.3.2",
		logPath:        logPath,
		staged: &stagedUpdate{
			version:  "v2.3.3",
			archive:  archive,
			platform: "darwin-arm64",
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: filepath.Join(root, appBundleName), Platform: "darwin-arm64"}, nil
		},
		helper: func(HelperRequest) error {
			<-unblock
			return nil
		},
		removeWorkDir: func(dir string) error {
			removeCalls++
			return os.RemoveAll(dir)
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	if err := engine.InstallUpdate(ctx); err == nil {
		t.Fatal("expected preparation timeout")
	}
	if removeCalls != 0 {
		t.Fatalf("workDir must be retained while helper has not exited, got removeCalls=%d", removeCalls)
	}
	state := engine.snapshot()
	if !strings.Contains(state.Error, "准备安装超时") {
		t.Fatalf("unexpected public timeout error: %+v", state)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "install helper did not exit; update files retained") {
		t.Fatalf("missing retained-files log line:\n%s", raw)
	}
	if !strings.Contains(string(raw), "install failure phase=preparing completedFiles=0 totalFiles=0 timeout=true step=wait_prepared reason=timeout") {
		t.Fatalf("missing timeout metadata in log:\n%s", raw)
	}
}

func TestInstallUpdateParentProbeFailureAbortsBeforePreparedAndQuit(t *testing.T) {
	root := t.TempDir()
	platform, targetPath, archive, data := writeNativeSubprocessFixture(t, root)
	sum := sha256.Sum256(data)

	origAcquire := acquireParentExitWait
	t.Cleanup(func() { acquireParentExitWait = origAcquire })
	var probeErr error
	var wantErrno uint32
	if runtime.GOOS == "windows" {
		wantErrno = kernel.Win32ErrorAccessDenied
		probeErr = &os.PathError{Op: "open", Path: "parent", Err: syscall.Errno(wantErrno)}
	} else {
		wantErrno = uint32(syscall.EACCES)
		probeErr = &os.PathError{Op: "open", Path: "parent", Err: syscall.EACCES}
	}
	acquireParentExitWait = func(int) (func(time.Duration) error, func(), error) {
		return nil, nil, probeErr
	}

	quitCalled := false
	sawPrepared := false
	logPath := filepath.Join(t.TempDir(), "update.log")
	engine := &Engine{
		enabled:        true,
		currentVersion: "v2.3.2",
		logPath:        logPath,
		parentPID:      os.Getpid(),
		staged: &stagedUpdate{
			version:  "v2.3.3",
			archive:  archive,
			platform: platform,
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: targetPath, Platform: platform}, nil
		},
		helper: func(req HelperRequest) error {
			err := RunHelperRequest(req)
			if pathExists(req.PreparedPath) {
				sawPrepared = true
			}
			return err
		},
		quit: func() error {
			quitCalled = true
			return nil
		},
	}

	if err := engine.InstallUpdate(context.Background()); err == nil {
		t.Fatal("expected install failure when parent-exit probe fails")
	}
	if quitCalled {
		t.Fatal("quit must not be called when parent-exit probe fails")
	}
	if sawPrepared {
		t.Fatal("prepared marker must not be written when parent-exit probe fails")
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	wantLine := fmt.Sprintf("install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=permission_denied errno=%d", wantErrno)
	if !strings.Contains(string(raw), wantLine) {
		t.Fatalf("missing parent-probe failure metadata (want %q):\n%s", wantLine, raw)
	}
}

func TestWorkDirCleanupFailureLogsSafeNotice(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	archive := writeRawZip(t, t.TempDir(), "bad.zip", map[string][]byte{"unexpected.txt": []byte("bad")})
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	logPath := filepath.Join(t.TempDir(), "update.log")

	engine := &Engine{
		enabled:        true,
		currentVersion: "v2.3.2",
		logPath:        logPath,
		staged: &stagedUpdate{
			archive:  archive,
			platform: "darwin-arm64",
			artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
		},
		locate: func() (Target, error) {
			return Target{Path: filepath.Join(root, appBundleName), Platform: "darwin-arm64"}, nil
		},
		removeWorkDir: func(string) error {
			return os.ErrPermission
		},
	}

	if err := engine.InstallUpdate(context.Background()); err == nil {
		t.Fatal("expected layout failure")
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "install update files retained after cleanup failure") {
		t.Fatalf("missing cleanup failure notice in log:\n%s", raw)
	}
}
