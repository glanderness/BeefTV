package kernel

import (
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
)

// Closed vocabulary of safe update-preparation step identifiers that may cross
// into exported diagnostics bundles.
const (
	UpdateStepStage          = "stage"
	UpdateStepVerify         = "verify"
	UpdateStepExtract        = "extract"
	UpdateStepValidateLayout = "validate_layout"
	UpdateStepWriteRequest   = "write_request"
	UpdateStepCopyHelper     = "copy_helper"
	UpdateStepStartHelper    = "start_helper"
	UpdateStepWaitPrepared   = "wait_prepared"
)

// UpdateFailureReason is the single closed vocabulary of safe update failure
// reason codes shared by desktopupdate (producer) and diagnostics (exporter).
type UpdateFailureReason string

const (
	UpdateReasonInvalidArchive     UpdateFailureReason = "invalid_archive"
	UpdateReasonVerificationFailed UpdateFailureReason = "verification_failed"
	UpdateReasonTimeout            UpdateFailureReason = "timeout"
	UpdateReasonDiskFull           UpdateFailureReason = "disk_full"
	UpdateReasonPermissionDenied   UpdateFailureReason = "permission_denied"
	UpdateReasonSharingViolation   UpdateFailureReason = "sharing_violation"
	UpdateReasonLockViolation      UpdateFailureReason = "lock_violation"
	UpdateReasonFileNotFound       UpdateFailureReason = "file_not_found"
	UpdateReasonFileBusy           UpdateFailureReason = "file_busy"
	UpdateReasonReadOnlyFS         UpdateFailureReason = "read_only_fs"
	UpdateReasonVirusBlocked       UpdateFailureReason = "virus_blocked"
	UpdateReasonElevationRequired  UpdateFailureReason = "elevation_required"
	UpdateReasonPolicyBlocked      UpdateFailureReason = "policy_blocked"
	UpdateReasonInstallLocked      UpdateFailureReason = "install_locked"
	UpdateReasonInvalidRequest     UpdateFailureReason = "invalid_request"
	UpdateReasonHelperExited       UpdateFailureReason = "helper_exited"
	UpdateReasonDataDirOverlap     UpdateFailureReason = "data_dir_overlap"
	UpdateReasonUnsupported        UpdateFailureReason = "unsupported"
	UpdateReasonConnectionReset    UpdateFailureReason = "connection_reset"
	UpdateReasonConnectionRefused  UpdateFailureReason = "connection_refused"
	UpdateReasonOSError            UpdateFailureReason = "os_error"
	UpdateReasonFailed             UpdateFailureReason = "failed"
)

var updateSteps = [...]string{
	UpdateStepStage,
	UpdateStepVerify,
	UpdateStepExtract,
	UpdateStepValidateLayout,
	UpdateStepWriteRequest,
	UpdateStepCopyHelper,
	UpdateStepStartHelper,
	UpdateStepWaitPrepared,
}

var updateFailureReasons = [...]UpdateFailureReason{
	UpdateReasonInvalidArchive,
	UpdateReasonVerificationFailed,
	UpdateReasonTimeout,
	UpdateReasonDiskFull,
	UpdateReasonPermissionDenied,
	UpdateReasonSharingViolation,
	UpdateReasonLockViolation,
	UpdateReasonFileNotFound,
	UpdateReasonFileBusy,
	UpdateReasonReadOnlyFS,
	UpdateReasonVirusBlocked,
	UpdateReasonElevationRequired,
	UpdateReasonPolicyBlocked,
	UpdateReasonInstallLocked,
	UpdateReasonInvalidRequest,
	UpdateReasonHelperExited,
	UpdateReasonDataDirOverlap,
	UpdateReasonUnsupported,
	UpdateReasonConnectionReset,
	UpdateReasonConnectionRefused,
	UpdateReasonOSError,
	UpdateReasonFailed,
}

var updateFailureTextMarkers = [...]struct {
	marker string
	reason UpdateFailureReason
}{
	{"permission denied", UpdateReasonPermissionDenied},
	{"access is denied", UpdateReasonPermissionDenied},
	{"拒绝访问", UpdateReasonPermissionDenied},
	{"sharing violation", UpdateReasonSharingViolation},
	{"being used by another process", UpdateReasonSharingViolation},
	{"另一个程序正在使用此文件", UpdateReasonSharingViolation},
	{"lock violation", UpdateReasonLockViolation},
	{"locked a portion of the file", UpdateReasonLockViolation},
	{"另一个程序已锁定文件的一部分", UpdateReasonLockViolation},
	{"virus", UpdateReasonVirusBlocked},
	{"potentially unwanted", UpdateReasonVirusBlocked},
	{"病毒", UpdateReasonVirusBlocked},
	{"垃圾软件", UpdateReasonVirusBlocked},
	{"requires elevation", UpdateReasonElevationRequired},
	{"需要提升", UpdateReasonElevationRequired},
	{"group policy", UpdateReasonPolicyBlocked},
	{"组策略", UpdateReasonPolicyBlocked},
	{"cannot find the file", UpdateReasonFileNotFound},
	{"cannot find the path specified", UpdateReasonFileNotFound},
	{"系统找不到指定的文件", UpdateReasonFileNotFound},
	{"系统找不到指定的路径", UpdateReasonFileNotFound},
	{"no such file", UpdateReasonFileNotFound},
	{"超时", UpdateReasonTimeout},
	{"deadline exceeded", UpdateReasonTimeout},
	{"timeout", UpdateReasonTimeout},
	{"已有更新正在安装", UpdateReasonInstallLocked},
	{"数据目录与程序目录重叠", UpdateReasonDataDirOverlap},
	{"文件损坏", UpdateReasonVerificationFailed},
	{"被篡改", UpdateReasonVerificationFailed},
	{"更新包格式无效", UpdateReasonInvalidArchive},
	{"更新包缺少", UpdateReasonInvalidArchive},
	{"更新包包含", UpdateReasonInvalidArchive},
	{"更新包可执行文件无效", UpdateReasonInvalidArchive},
	{"更新包内置助手资源不完整", UpdateReasonInvalidArchive},
	{"更新包视频工具不完整", UpdateReasonInvalidArchive},
	{"更新包媒体检查工具不完整", UpdateReasonInvalidArchive},
	{"官方插件目录布局无效", UpdateReasonInvalidArchive},
	{"当前系统不支持自动更新", UpdateReasonUnsupported},
	{"更新请求", UpdateReasonInvalidRequest},
	{"更新路径无效", UpdateReasonInvalidRequest},
	{"不支持自动更新", UpdateReasonInvalidRequest},
	{"helper exited before signaling prepared", UpdateReasonHelperExited},
	{"connection reset", UpdateReasonConnectionReset},
	{"connection refused", UpdateReasonConnectionRefused},
}

// IsValidUpdateStep reports whether step is in the closed allowlisted step set.
func IsValidUpdateStep(step string) bool {
	return slices.Contains(updateSteps[:], step)
}

// Valid reports whether r is in the closed allowlisted update reason set.
func (r UpdateFailureReason) Valid() bool {
	return slices.Contains(updateFailureReasons[:], r)
}

// UpdateFailureMeta holds the zero-PII structured diagnostic fields emitted by
// desktopupdate and validated/exported by diagnostics.
type UpdateFailureMeta struct {
	Step        string
	Reason      UpdateFailureReason
	Errno       uint32
	HasErrno    bool
	ExitCode    int64
	HasExitCode bool
}

// Format renders allowlisted metadata tokens in canonical order.
func (m UpdateFailureMeta) Format() string {
	var parts []string
	if IsValidUpdateStep(m.Step) {
		parts = append(parts, "step="+m.Step)
	}
	if m.Reason.Valid() {
		parts = append(parts, "reason="+string(m.Reason))
	}
	if m.HasErrno {
		parts = append(parts, "errno="+strconv.FormatUint(uint64(m.Errno), 10))
	}
	if m.HasExitCode && isValidUpdateExitCode(m.ExitCode) {
		parts = append(parts, "exitCode="+strconv.FormatInt(m.ExitCode, 10))
	}
	return strings.Join(parts, " ")
}

// ParseUpdateFailureMeta parses allowlisted step=/reason=/errno=/exitCode=
// tokens from a space-separated string, dropping unknown or invalid tokens
// (first valid value per key wins).
func ParseUpdateFailureMeta(text string) (UpdateFailureMeta, bool) {
	if text == "" {
		return UpdateFailureMeta{}, false
	}
	var meta UpdateFailureMeta
	var hasStep, hasReason bool
	found := false
	for _, token := range strings.Split(text, " ") {
		key, val, ok := strings.Cut(token, "=")
		if !ok || val == "" {
			continue
		}
		switch key {
		case "step":
			if !hasStep && IsValidUpdateStep(val) {
				meta.Step = val
				hasStep = true
				found = true
			}
		case "reason":
			r := UpdateFailureReason(val)
			if !hasReason && r.Valid() {
				meta.Reason = r
				hasReason = true
				found = true
			}
		case "errno":
			if !meta.HasErrno && isASCIIDigits(val) {
				if parsed, err := strconv.ParseUint(val, 10, 32); err == nil {
					meta.Errno = uint32(parsed)
					meta.HasErrno = true
					found = true
				}
			}
		case "exitCode":
			if !meta.HasExitCode {
				if parsed, ok := parseUpdateExitCode(val); ok {
					meta.ExitCode = parsed
					meta.HasExitCode = true
					found = true
				}
			}
		}
	}
	return meta, found
}

// ClassifyWindowsUpdateErrno maps a Win32 error code to a safe closed reason.
func ClassifyWindowsUpdateErrno(code uint32) UpdateFailureReason {
	if IsWindowsDiskFullCode(code) {
		return UpdateReasonDiskFull
	}
	switch code {
	case Win32ErrorFileNotFound, Win32ErrorPathNotFound:
		return UpdateReasonFileNotFound
	case Win32ErrorAccessDenied:
		return UpdateReasonPermissionDenied
	case Win32ErrorSharingViolation:
		return UpdateReasonSharingViolation
	case Win32ErrorLockViolation:
		return UpdateReasonLockViolation
	case Win32ErrorVirusInfected, Win32ErrorVirusDeleted:
		return UpdateReasonVirusBlocked
	case Win32ErrorElevationRequired:
		return UpdateReasonElevationRequired
	case Win32ErrorAccessDisabledByPolicy:
		return UpdateReasonPolicyBlocked
	default:
		return ""
	}
}

// ClassifyUpdateFailureText maps raw local/update error text to a safe closed
// reason code without returning any part of the raw message.
func ClassifyUpdateFailureText(text string) UpdateFailureReason {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if IsDiskFullError(errors.New(text)) {
		return UpdateReasonDiskFull
	}
	lower := strings.ToLower(text)
	for _, item := range updateFailureTextMarkers {
		if strings.Contains(lower, item.marker) {
			return item.reason
		}
	}
	return ""
}

// SanitizeUpdateFailureMeta filters key=value tokens from an install-failure
// suffix, keeping only allowlisted diagnostic keys/values and dropping unknown
// or invalid tokens without losing valid ones.
func SanitizeUpdateFailureMeta(text string) string {
	meta, ok := ParseUpdateFailureMeta(text)
	if !ok {
		return ""
	}
	return meta.Format()
}

// SanitizeUpdateFailurePrefix extracts safe structured metadata from the
// prefix of an "install preparation failed: <meta>: <raw>" message. It returns
// empty unless the prefix begins with an allowlisted step or reason token.
func SanitizeUpdateFailurePrefix(rest string) string {
	prefix := rest
	if idx := strings.Index(rest, ": "); idx >= 0 {
		prefix = rest[:idx]
	}
	first, _, _ := strings.Cut(prefix, " ")
	firstMeta, ok := ParseUpdateFailureMeta(first)
	if !ok || (firstMeta.Step == "" && firstMeta.Reason == "") {
		return ""
	}
	return SanitizeUpdateFailureMeta(prefix)
}

func isValidUpdateExitCode(v int64) bool {
	// Windows 64-bit NTSTATUS exit codes (e.g. 0xC0000005 = 3221225477) span
	// uint32 while Unix signal exit codes can be negative.
	return v >= math.MinInt32 && v <= math.MaxUint32
}

func parseUpdateExitCode(val string) (int64, bool) {
	digits := val
	if strings.HasPrefix(digits, "-") {
		digits = digits[1:]
	}
	if !isASCIIDigits(digits) {
		return 0, false
	}
	v, err := strconv.ParseInt(val, 10, 64)
	return v, err == nil && isValidUpdateExitCode(v)
}

func isASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
