//go:build unix

package desktopupdate

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

func waitForPID(pid int, timeout time.Duration) error {
	if pid <= 0 {
		return fmt.Errorf("更新请求缺少进程信息")
	}
	deadline := time.Now().Add(timeout)
	for {
		err := syscall.Kill(pid, 0)
		if err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			if errors.Is(err, syscall.EPERM) {
				// Process exists but is not signalable by this user.
			} else {
				return err
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待应用退出超时")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func isCrossDevice(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.EXDEV) {
		return true
	}
	var link *os.LinkError
	if errors.As(err, &link) && (errors.Is(link.Err, syscall.EXDEV) || link.Err == syscall.EXDEV) {
		return true
	}
	return false
}

func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func lockInstall(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, err
	}
	// A contender may have opened the old inode just before its owner unlinked
	// it. It must not proceed alongside a process locking the replacement inode.
	opened, statErr := file.Stat()
	current, pathErr := os.Lstat(path)
	if statErr != nil || pathErr != nil || !current.Mode().IsRegular() || !os.SameFile(opened, current) {
		_ = file.Close()
		return nil, fmt.Errorf("更新锁已变更，请重试")
	}
	return func() {
		_ = os.Remove(path)
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}
