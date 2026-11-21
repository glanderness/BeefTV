//go:build windows

package desktopupdate

import (
	"errors"
	"fmt"
	"syscall"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/webviewlock"

	"golang.org/x/sys/windows"
)

const (
	synchronizeAccess            = 0x00100000
	waitObject0           uint32 = 0
	errorInvalidParameter        = syscall.Errno(87)
)

func openParentExitWait(pid int) (func(time.Duration) error, func(), error) {
	if pid <= 0 {
		return nil, nil, fmt.Errorf("更新请求缺少进程信息")
	}
	handle, err := syscall.OpenProcess(synchronizeAccess, false, uint32(pid))
	if err != nil {
		if errors.Is(err, errorInvalidParameter) {
			return func(time.Duration) error { return nil }, func() {}, nil
		}
		return nil, nil, err
	}
	wait := func(timeout time.Duration) error {
		millis := uint32(timeout / time.Millisecond)
		if millis == 0 {
			millis = 1
		}
		status, err := syscall.WaitForSingleObject(handle, millis)
		if err != nil {
			return err
		}
		if status == waitObject0 {
			return nil
		}
		return fmt.Errorf("等待应用退出超时")
	}
	closeFn := func() { _ = syscall.CloseHandle(handle) }
	return wait, closeFn, nil
}

func resolvePlatformWebViewProfileDir(targetPath, dataDir string) string {
	return webviewlock.ProfileDirForWorkspace(targetPath, dataDir)
}

func waitPlatformWebViewReleased(profileDir string) {
	if profileDir == "" {
		return
	}
	_ = webviewlock.WaitAndReclaimUnownedProfile(profileDir, webviewlock.DefaultGracefulWait, webviewlock.DefaultReclaimWait)
}

func detachedSysProcAttr() *syscall.SysProcAttr {
	const detachedProcess = 0x00000008
	const createNewProcessGroup = 0x00000200
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
}

func isRetryableHelperStartError(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

func classifyPlatformErrno(errno syscall.Errno) kernel.UpdateFailureReason {
	return kernel.ClassifyWindowsUpdateErrno(uint32(errno))
}

func lockInstall(path string) (func(), error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// Exclusive sharing also excludes old helpers that use LockFileEx. Windows
	// deletes the file atomically when this handle closes, including on a crash.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.DELETE, 0, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_DELETE_ON_CLOSE|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, fmt.Errorf("%w: %w", errInstallLockBusy, err)
		}
		return nil, err
	}
	return func() { _ = windows.CloseHandle(handle) }, nil
}
