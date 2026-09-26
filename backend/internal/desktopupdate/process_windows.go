//go:build windows

package desktopupdate

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"syscall"
	"time"
)

const (
	synchronizeAccess            = 0x00100000
	waitObject0           uint32 = 0
	errorInvalidParameter        = syscall.Errno(87)
	errorNotSameDevice           = syscall.Errno(17)
)

func waitForPID(pid int, timeout time.Duration) error {
	if pid <= 0 {
		return fmt.Errorf("更新请求缺少进程信息")
	}
	handle, err := syscall.OpenProcess(synchronizeAccess, false, uint32(pid))
	if err != nil {
		if errors.Is(err, errorInvalidParameter) {
			return nil
		}
		return err
	}
	defer syscall.CloseHandle(handle)
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

func isCrossDevice(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == errorNotSameDevice {
		return true
	}
	var link *os.LinkError
	if errors.As(err, &link) {
		if errors.As(link.Err, &errno) && errno == errorNotSameDevice {
			return true
		}
	}
	return false
}

func detachedSysProcAttr() *syscall.SysProcAttr {
	const detachedProcess = 0x00000008
	const createNewProcessGroup = 0x00000200
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
}

func lockInstall(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	var overlapped windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() { _ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped); _ = file.Close() }, nil
}
