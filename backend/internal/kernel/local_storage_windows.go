//go:build windows

package kernel

import (
	"errors"
	"syscall"
)

func isDiskFullErrno(err error) bool {
	return errors.Is(err, syscall.Errno(Win32ErrorDiskFull)) ||
		errors.Is(err, syscall.Errno(Win32ErrorHandleDiskFull)) ||
		errors.Is(err, syscall.ENOSPC) ||
		errors.Is(err, syscall.EDQUOT)
}
