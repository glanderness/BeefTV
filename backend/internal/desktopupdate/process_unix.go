//go:build unix

package desktopupdate

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

func openParentExitWait(pid int) (func(time.Duration) error, func(), error) {
	if pid <= 0 {
		return nil, nil, fmt.Errorf("更新请求缺少进程信息")
	}
	if err := syscall.Kill(pid, 0); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return func(time.Duration) error { return nil }, func() {}, nil
		}
		if !errors.Is(err, syscall.EPERM) {
			return nil, nil, err
		}
	}
	wait := func(timeout time.Duration) error {
		deadline := time.Now().Add(timeout)
		for {
			err := syscall.Kill(pid, 0)
			if err != nil {
				if errors.Is(err, syscall.ESRCH) {
					return nil
				}
				if !errors.Is(err, syscall.EPERM) {
					return err
				}
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("等待应用退出超时")
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	return wait, func() {}, nil
}

func resolvePlatformWebViewProfileDir(string, string) string { return "" }

func waitPlatformWebViewReleased(string) {}

func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func isRetryableHelperStartError(error) bool {
	return false
}

func classifyPlatformErrno(errno syscall.Errno) kernel.UpdateFailureReason {
	switch errno {
	case syscall.ENOENT:
		return kernel.UpdateReasonFileNotFound
	case syscall.EACCES, syscall.EPERM:
		return kernel.UpdateReasonPermissionDenied
	case syscall.ENOSPC, syscall.EDQUOT:
		return kernel.UpdateReasonDiskFull
	case syscall.ETXTBSY:
		return kernel.UpdateReasonFileBusy
	case syscall.EROFS:
		return kernel.UpdateReasonReadOnlyFS
	default:
		return ""
	}
}

func lockInstall(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w: %w", errInstallLockBusy, err)
		}
		return nil, err
	}
	// Keep this stable inode: older helpers can already have opened it before
	// flock. Unlinking would let them lock an orphan while a new helper locks
	// its replacement. The empty lock is shared coordination, not update data.
	return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() }, nil
}
