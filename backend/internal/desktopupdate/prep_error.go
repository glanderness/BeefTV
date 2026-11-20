package desktopupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"infinite-canvas/backend/internal/kernel"
)

const (
	prepStepStage          = kernel.UpdateStepStage
	prepStepVerify         = kernel.UpdateStepVerify
	prepStepExtract        = kernel.UpdateStepExtract
	prepStepValidateLayout = kernel.UpdateStepValidateLayout
	prepStepWriteRequest   = kernel.UpdateStepWriteRequest
	prepStepCopyHelper     = kernel.UpdateStepCopyHelper
	prepStepStartHelper    = kernel.UpdateStepStartHelper
	prepStepWaitPrepared   = kernel.UpdateStepWaitPrepared
)

type prepError struct {
	step        string
	reason      kernel.UpdateFailureReason
	errno       uint32
	hasErrno    bool
	exitCode    int
	hasExitCode bool
	timedOut    bool
	err         error
}

func isPreparationTimedOut(err error) bool {
	if errors.Is(err, ErrPreparationTimeout) {
		return true
	}
	var pe *prepError
	return errors.As(err, &pe) && pe.timedOut
}

func (e *prepError) Error() string {
	meta := e.meta()
	if e.err == nil {
		return meta
	}
	if meta == "" {
		return e.err.Error()
	}
	return meta + ": " + e.err.Error()
}

func (e *prepError) Unwrap() error {
	return e.err
}

func (e *prepError) meta() string {
	return kernel.UpdateFailureMeta{
		Step:        e.step,
		Reason:      e.reason,
		Errno:       e.errno,
		HasErrno:    e.hasErrno,
		ExitCode:    int64(e.exitCode),
		HasExitCode: e.hasExitCode,
	}.Format()
}

type helperExitedError struct {
	err error
}

func (e *helperExitedError) Error() string {
	if e.err == nil {
		return "helper exited before signaling prepared"
	}
	return fmt.Sprintf("helper exited before signaling prepared: %v", e.err)
}

func (e *helperExitedError) Unwrap() error {
	return e.err
}

func extractErrno(err error) (uint32, bool) {
	var sysErrno syscall.Errno
	if errors.As(err, &sysErrno) && sysErrno != 0 {
		return uint32(sysErrno), true
	}
	return 0, false
}

func extractExitCode(err error) (int, bool) {
	var procExit *exec.ExitError
	if errors.As(err, &procExit) {
		return procExit.ExitCode(), true
	}
	return 0, false
}

func wrapPrepError(step string, err error) error {
	if err == nil {
		return nil
	}
	reason, errno, hasErrno := classifyInstallFailure(err)
	return &prepError{
		step:     step,
		reason:   reason,
		errno:    errno,
		hasErrno: hasErrno,
		err:      err,
	}
}

func classifyHelperRecord(resultPath, helperLogPath string) (step string, reason kernel.UpdateFailureReason, errno uint32, hasErrno bool) {
	if resultPath != "" {
		var rec RecoveryState
		if readCleanupRecord(resultPath, &rec) == nil {
			if kernel.IsValidUpdateStep(rec.FailureStep) {
				step = rec.FailureStep
			}
			if rec.ErrorCode != 0 {
				errno = rec.ErrorCode
				hasErrno = true
			}
			if rec.FailureReason.Valid() {
				reason = rec.FailureReason
			} else {
				recErr := strings.TrimSpace(rec.Error)
				switch {
				case recErr == errInstallLockBusy.Error():
					reason = kernel.UpdateReasonInstallLocked
				case rec.ErrorCode != 0:
					reason = classifyPlatformErrno(syscall.Errno(rec.ErrorCode))
				}
				if reason == "" && recErr != "" {
					reason = kernel.ClassifyUpdateFailureText(recErr)
				}
			}
		}
	}
	if reason == "" && helperLogPath != "" {
		logStep, logReason, logErrno, logHasErrno := classifyHelperLog(readBoundedTail(helperLogPath, 4096))
		if step == "" {
			step = logStep
		}
		if reason == "" {
			reason = logReason
		}
		if !hasErrno && logHasErrno {
			errno = logErrno
			hasErrno = true
		}
	}
	return step, reason, errno, hasErrno
}

func classifyHelperLog(tail string) (step string, reason kernel.UpdateFailureReason, errno uint32, hasErrno bool) {
	if strings.TrimSpace(tail) == "" {
		return "", "", 0, false
	}
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		prefix, _, _ := strings.Cut(line, ": ")
		meta, ok := kernel.ParseUpdateFailureMeta(prefix)
		if !ok || (meta.Step == "" && meta.Reason == "") {
			continue
		}
		logReason := meta.Reason
		if logReason == "" {
			logReason = kernel.ClassifyUpdateFailureText(line)
		}
		return meta.Step, logReason, meta.Errno, meta.HasErrno && meta.Errno != 0
	}
	return "", kernel.ClassifyUpdateFailureText(tail), 0, false
}

func wrapWaitPreparedError(err, killedExitErr error, resultPath, helperLogPath string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrPreparationTimeout) {
		// If the helper recorded a concrete failure in result.json or helper.log
		// right before timing out or being terminated, surface that real reason.
		if recStep, reason, errno, hasErrno := classifyHelperRecord(resultPath, helperLogPath); reason != "" || hasErrno {
			if reason == "" {
				reason = kernel.UpdateReasonOSError
			}
			step := prepStepWaitPrepared
			if recStep != "" {
				step = recStep
			}
			exitCode, hasExitCode := extractExitCode(killedExitErr)
			if !hasErrno {
				errno, hasErrno = extractErrno(killedExitErr)
			}
			return &prepError{
				step:        step,
				reason:      reason,
				errno:       errno,
				hasErrno:    hasErrno,
				exitCode:    exitCode,
				hasExitCode: hasExitCode,
				timedOut:    true,
				err:         fmt.Errorf("helper failed during preparation: %s", reason),
			}
		}
		return wrapPrepError(prepStepWaitPrepared, err)
	}
	var exited *helperExitedError
	if !errors.As(err, &exited) {
		return wrapPrepError(prepStepWaitPrepared, err)
	}
	var (
		exitCode    int
		hasExitCode bool
		errno       uint32
		hasErrno    bool
		reason      kernel.UpdateFailureReason
		exitedStep  string
	)
	if exited.err != nil {
		exitCode, hasExitCode = extractExitCode(exited.err)
		var pe *prepError
		if errors.As(exited.err, &pe) && kernel.IsValidUpdateStep(pe.step) {
			exitedStep = pe.step
		}
		var r kernel.UpdateFailureReason
		r, errno, hasErrno = classifyInstallFailure(exited.err)
		if r != "" && r != kernel.UpdateReasonFailed && r != kernel.UpdateReasonOSError {
			reason = r
		}
	}
	recStep, recReason, recErrno, recHasErrno := classifyHelperRecord(resultPath, helperLogPath)
	step := prepStepWaitPrepared
	if recStep != "" {
		step = recStep
	} else if exitedStep != "" {
		step = exitedStep
	}
	if !hasErrno && recHasErrno {
		errno = recErrno
		hasErrno = true
	}
	if reason == "" {
		reason = recReason
	}
	if reason == "" {
		if hasErrno {
			reason = kernel.UpdateReasonOSError
		} else {
			reason = kernel.UpdateReasonHelperExited
		}
	}
	return &prepError{
		step:        step,
		reason:      reason,
		errno:       errno,
		hasErrno:    hasErrno,
		exitCode:    exitCode,
		hasExitCode: hasExitCode,
		err:         err,
	}
}

func formatInstallFailureMeta(err error) string {
	if err == nil {
		return ""
	}
	var pe *prepError
	if errors.As(err, &pe) {
		if meta := pe.meta(); meta != "" {
			return " " + meta
		}
		return ""
	}
	reason, errno, hasErrno := classifyInstallFailure(err)
	meta := kernel.UpdateFailureMeta{
		Reason:   reason,
		Errno:    errno,
		HasErrno: hasErrno,
	}.Format()
	if meta == "" {
		return ""
	}
	return " " + meta
}

func formatHelperStoppedMeta(helperErr error, resultPath, helperLogPath string) string {
	step, reason, errno, hasErrno := classifyHelperRecord(resultPath, helperLogPath)
	exitCode, hasExitCode := extractExitCode(helperErr)
	if !hasErrno {
		errno, hasErrno = extractErrno(helperErr)
	}
	if reason == "" && helperErr != nil {
		r, _, _ := classifyInstallFailure(helperErr)
		if r != "" && r != kernel.UpdateReasonFailed && r != kernel.UpdateReasonOSError {
			reason = r
		} else if hasErrno {
			reason = kernel.UpdateReasonOSError
		} else if hasExitCode {
			reason = kernel.UpdateReasonHelperExited
		}
	}
	if step == "" && reason == "" {
		return ""
	}
	return kernel.UpdateFailureMeta{
		Step:        step,
		Reason:      reason,
		Errno:       errno,
		HasErrno:    hasErrno,
		ExitCode:    int64(exitCode),
		HasExitCode: hasExitCode,
	}.Format()
}

func classifyInstallFailure(err error) (kernel.UpdateFailureReason, uint32, bool) {
	if err == nil {
		return "", 0, false
	}
	var pe *prepError
	if errors.As(err, &pe) {
		return pe.reason, pe.errno, pe.hasErrno
	}
	errno, hasErrno := extractErrno(err)
	if !hasErrno {
		if cause := rawCause(err); cause != err {
			errno, hasErrno = extractErrno(cause)
		}
	}
	switch {
	case errors.Is(err, ErrPreparationTimeout) || errors.Is(err, ErrTimeout) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		return kernel.UpdateReasonTimeout, errno, hasErrno
	case errors.Is(err, ErrTampered):
		return kernel.UpdateReasonVerificationFailed, errno, hasErrno
	case errors.Is(err, ErrUnsupported):
		return kernel.UpdateReasonUnsupported, errno, hasErrno
	case errors.Is(err, errInstallLockBusy):
		return kernel.UpdateReasonInstallLocked, errno, hasErrno
	case kernel.IsDiskFullError(err):
		return kernel.UpdateReasonDiskFull, errno, hasErrno
	}
	if hasErrno {
		if reason := classifyPlatformErrno(syscall.Errno(errno)); reason != "" {
			return reason, errno, true
		}
	}
	switch {
	case errors.Is(err, os.ErrPermission):
		return kernel.UpdateReasonPermissionDenied, errno, hasErrno
	case errors.Is(err, os.ErrNotExist):
		return kernel.UpdateReasonFileNotFound, errno, hasErrno
	case errors.Is(err, ErrInvalidArchive):
		return kernel.UpdateReasonInvalidArchive, errno, hasErrno
	}
	if reason := kernel.ClassifyUpdateFailureText(rawCause(err).Error()); reason != "" {
		return reason, errno, hasErrno
	}
	if hasErrno {
		return kernel.UpdateReasonOSError, errno, true
	}
	return kernel.UpdateReasonFailed, 0, false
}

// Distinguish actionable local installation failures from transfer failures.
func publicInstallError(err error) string {
	if err == nil {
		return "安装准备失败，已保留下载内容，请重试安装。"
	}
	if errors.Is(err, ErrPreparationTimeout) {
		return ErrPreparationTimeout.Error()
	}
	if errors.Is(err, ErrTimeout) {
		return ErrTimeout.Error()
	}
	step := ""
	var pe *prepError
	if errors.As(err, &pe) {
		step = pe.step
	}
	reason, _, _ := classifyInstallFailure(err)
	switch reason {
	case kernel.UpdateReasonTimeout:
		return ErrPreparationTimeout.Error()
	case kernel.UpdateReasonVerificationFailed:
		return publicError(ErrTampered)
	case kernel.UpdateReasonInvalidArchive:
		return ErrInvalidArchive.Error()
	case kernel.UpdateReasonUnsupported:
		return ErrUnsupported.Error()
	case kernel.UpdateReasonDiskFull:
		return "磁盘空间不足，请释放空间后重试安装。"
	case kernel.UpdateReasonPermissionDenied:
		switch step {
		case prepStepVerify, prepStepValidateLayout:
			return "无法读取已下载的更新文件，请检查权限或重新下载更新。"
		case prepStepStartHelper:
			return "更新程序被系统或安全软件拦截，请允许 BeefTV 运行后重试，或下载安装包手动更新。"
		case prepStepWaitPrepared:
			return "更新程序无权协同当前应用进程，请关闭应用后下载安装包手动更新，或以相同权限重试。"
		default:
			return "无法写入应用安装目录，请检查目录权限后重试安装。"
		}
	case kernel.UpdateReasonFileNotFound:
		switch step {
		case prepStepVerify, prepStepValidateLayout:
			return "更新文件缺失，可能被安全软件删除，请重新下载更新。"
		case prepStepCopyHelper, prepStepStartHelper:
			return "更新程序缺失，可能被安全软件隔离，请将 BeefTV 加入白名单后重新下载安装。"
		default:
			return "更新所需文件缺失，请重新下载更新。"
		}
	case kernel.UpdateReasonVirusBlocked:
		return "更新程序被安全软件拦截，请将 BeefTV 加入白名单后重新下载安装。"
	case kernel.UpdateReasonElevationRequired:
		return "当前目录需要管理员权限才能更新，请以管理员身份运行后重试。"
	case kernel.UpdateReasonPolicyBlocked:
		return "系统策略阻止运行更新程序，请联系管理员或改用安装包手动更新。"
	case kernel.UpdateReasonSharingViolation, kernel.UpdateReasonLockViolation, kernel.UpdateReasonFileBusy:
		return "更新文件正被安全软件或其他程序占用，请稍后重试或关闭占用程序后再更新。"
	case kernel.UpdateReasonReadOnlyFS:
		return "当前应用所在磁盘为只读状态，请移至可写目录后再更新。"
	case kernel.UpdateReasonInstallLocked:
		return "已有更新正在安装，请等待完成或重启应用后重试。"
	case kernel.UpdateReasonDataDirOverlap:
		return "数据目录与程序目录重叠，请先将数据移到独立目录。"
	case kernel.UpdateReasonInvalidRequest:
		return "更新准备参数无效，请重试安装。"
	}
	return "安装准备失败，已保留下载内容，请重试安装。"
}

func readBoundedTail(path string, maxBytes int64) string {
	if path == "" || maxBytes <= 0 {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil && info.Size() > maxBytes {
		_, _ = file.Seek(info.Size()-maxBytes, io.SeekStart)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes))
	if err != nil {
		return ""
	}
	return string(data)
}
