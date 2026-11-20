//go:build !windows

package kernel

import (
	"os"
	"syscall"
	"testing"
)

func TestDiskFullErrorNonWindowsErrnoGuardAndQuota(t *testing.T) {
	if !IsDiskFullError(&os.PathError{Op: "write", Path: "/tmp/a", Err: syscall.EDQUOT}) {
		t.Fatal("EDQUOT should classify as disk full")
	}
	// Windows ERROR_DISK_FULL (112) and ERROR_HANDLE_DISK_FULL (39) collide with
	// unrelated errnos on non-Windows OSes (e.g. Linux EHOSTDOWN = 112) and must
	// not be misclassified as disk full.
	for _, code := range []syscall.Errno{syscall.Errno(112), syscall.Errno(39)} {
		if IsDiskFullError(&os.PathError{Op: "read", Path: "/tmp/a", Err: code}) {
			t.Fatalf("non-Windows errno %d misclassified as disk full", code)
		}
	}
}
