package kernel

import "strings"

const (
	Win32ErrorFileNotFound           uint32 = 2
	Win32ErrorPathNotFound           uint32 = 3
	Win32ErrorAccessDenied           uint32 = 5
	Win32ErrorSharingViolation       uint32 = 32
	Win32ErrorLockViolation          uint32 = 33
	Win32ErrorHandleDiskFull         uint32 = 39
	Win32ErrorDiskFull               uint32 = 112
	Win32ErrorVirusInfected          uint32 = 225
	Win32ErrorVirusDeleted           uint32 = 226
	Win32ErrorElevationRequired      uint32 = 740
	Win32ErrorAccessDisabledByPolicy uint32 = 1260
)

// IsWindowsDiskFullCode reports whether a Win32 error code denotes a full disk.
func IsWindowsDiskFullCode(code uint32) bool {
	return code == Win32ErrorDiskFull || code == Win32ErrorHandleDiskFull
}

// IsDiskFullError reports whether a local storage error indicates insufficient
// disk space across Unix and Windows, including localized messages.
func IsDiskFullError(cause error) bool {
	if cause == nil {
		return false
	}
	if isDiskFullErrno(cause) {
		return true
	}
	text := strings.ToLower(cause.Error())
	return strings.Contains(text, "no space left") ||
		strings.Contains(text, "not enough space") ||
		strings.Contains(text, "disk quota exceeded") ||
		strings.Contains(text, "database or disk is full") ||
		strings.Contains(text, "the disk is full") ||
		strings.Contains(text, "磁盘空间不足")
}

// DiskFullError is used only at local storage boundaries, never on provider bodies.
func DiskFullError(cause error) *AppError {
	if !IsDiskFullError(cause) {
		return nil
	}
	return &AppError{Status: 500, Code: 500, Reason: "local_disk_full", Message: "本地磁盘空间不足，无法保存数据。请清理 BeefTV 数据目录所在磁盘；已有生成结果请优先取回原任务，不要重复生成", Cause: cause}
}
