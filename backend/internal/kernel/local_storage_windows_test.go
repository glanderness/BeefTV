//go:build windows

package kernel

import (
	"os"
	"syscall"
	"testing"
)

func TestDiskFullErrorRecognizesWindowsErrno(t *testing.T) {
	for _, errno := range []syscall.Errno{
		syscall.Errno(Win32ErrorDiskFull),
		syscall.Errno(Win32ErrorHandleDiskFull),
		syscall.ENOSPC,
		syscall.EDQUOT,
	} {
		cause := &os.PathError{Op: "write", Path: `C:\Users\private\data`, Err: errno}
		if !IsDiskFullError(cause) {
			t.Fatalf("IsDiskFullError(errno=%d) = false", errno)
		}
		got := DiskFullError(cause)
		if got == nil || got.Reason != "local_disk_full" || got.Cause != cause {
			t.Fatalf("DiskFullError(errno=%d) = %#v", errno, got)
		}
	}
	if IsDiskFullError(&os.PathError{Op: "open", Path: `C:\a`, Err: syscall.Errno(5)}) {
		t.Fatal("ERROR_ACCESS_DENIED misclassified as disk full")
	}
}
