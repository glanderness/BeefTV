//go:build windows

package desktopupdate

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsRetryableHelperStartErrors(t *testing.T) {
	for _, retryable := range []error{
		windows.ERROR_SHARING_VIOLATION,
		windows.ERROR_LOCK_VIOLATION,
		windows.ERROR_ACCESS_DENIED,
		&os.PathError{Op: "fork/exec", Path: `C:\App\BeefTV-update-helper.exe`, Err: windows.ERROR_SHARING_VIOLATION},
		fmt.Errorf("wrapped: %w", windows.ERROR_LOCK_VIOLATION),
	} {
		if !isRetryableHelperStartError(retryable) {
			t.Fatalf("expected retryable for %v", retryable)
		}
	}
	for _, fatal := range []error{
		nil,
		windows.ERROR_FILE_NOT_FOUND,
		windows.ERROR_DISK_FULL,
		windows.ERROR_VIRUS_INFECTED,
		windows.ERROR_ELEVATION_REQUIRED,
		windows.ERROR_ACCESS_DISABLED_BY_POLICY,
	} {
		if isRetryableHelperStartError(fatal) {
			t.Fatalf("unexpected retryable for %v", fatal)
		}
	}
}

func TestWindowsDiskFullAndPrepErrorMetadata(t *testing.T) {
	const wantDiskFull = "磁盘空间不足，请释放空间后重试安装。"
	for _, errno := range []windows.Errno{windows.ERROR_DISK_FULL, windows.ERROR_HANDLE_DISK_FULL} {
		err := &os.PathError{Op: "write", Path: `C:\App\helper.exe`, Err: errno}
		if got := publicInstallError(err); got != wantDiskFull {
			t.Fatalf("publicInstallError(errno=%d) = %q, want %q", errno, got, wantDiskFull)
		}
		wrapped := wrapPrepError(prepStepCopyHelper, err)
		wantMeta := fmt.Sprintf(" step=copy_helper reason=disk_full errno=%d", uint32(errno))
		if got := formatInstallFailureMeta(wrapped); got != wantMeta {
			t.Fatalf("formatInstallFailureMeta(errno=%d) = %q, want %q", errno, got, wantMeta)
		}
	}

	checks := []struct {
		errno  windows.Errno
		reason string
	}{
		{windows.ERROR_FILE_NOT_FOUND, "file_not_found"},
		{windows.ERROR_ACCESS_DENIED, "permission_denied"},
		{windows.ERROR_SHARING_VIOLATION, "sharing_violation"},
		{windows.ERROR_LOCK_VIOLATION, "lock_violation"},
		{windows.ERROR_VIRUS_INFECTED, "virus_blocked"},
		{windows.ERROR_VIRUS_DELETED, "virus_blocked"},
		{windows.ERROR_ELEVATION_REQUIRED, "elevation_required"},
		{windows.ERROR_ACCESS_DISABLED_BY_POLICY, "policy_blocked"},
	}
	for _, tc := range checks {
		err := wrapPrepError(prepStepStartHelper, &os.PathError{Op: "fork/exec", Path: `C:\Users\private\helper.exe`, Err: tc.errno})
		want := fmt.Sprintf(" step=start_helper reason=%s errno=%d", tc.reason, uint32(tc.errno))
		if got := formatInstallFailureMeta(err); got != want {
			t.Fatalf("errno=%d: meta=%q want=%q", tc.errno, got, want)
		}
		if !strings.HasPrefix(err.Error(), strings.TrimSpace(want)+": ") {
			t.Fatalf("err.Error() = %q", err.Error())
		}
	}
}

func expectedLockBusyErrno() uint32 {
	return uint32(windows.ERROR_SHARING_VIOLATION)
}
