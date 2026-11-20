package desktopupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"

	"infinite-canvas/backend/internal/kernel"
)

func TestPublicInstallErrorAndWindowsErrnoClassification(t *testing.T) {
	const wantDiskFull = "磁盘空间不足，请释放空间后重试安装。"
	for _, err := range []error{
		&os.PathError{Op: "write", Path: "/tmp/file", Err: syscall.ENOSPC},
		errors.New("write C:\\BeefTV\\helper.exe: There is not enough space on the disk."),
		errors.New("not enough space"),
		errors.New("no space left on device"),
		errors.New("write C:\\BeefTV\\helper.exe: 磁盘空间不足。"),
		&prepError{step: prepStepCopyHelper, reason: kernel.ClassifyWindowsUpdateErrno(kernel.Win32ErrorDiskFull), errno: kernel.Win32ErrorDiskFull, hasErrno: true, err: errors.New("win32")},
	} {
		if got := publicInstallError(err); got != wantDiskFull {
			t.Fatalf("publicInstallError(%v) = %q, want %q", err, got, wantDiskFull)
		}
	}

	for _, tc := range []struct {
		step   string
		reason kernel.UpdateFailureReason
		want   string
	}{
		{prepStepCopyHelper, kernel.UpdateReasonDiskFull, wantDiskFull},
		{prepStepStage, kernel.UpdateReasonPermissionDenied, "无法写入应用安装目录，请检查目录权限后重试安装。"},
		{prepStepCopyHelper, kernel.UpdateReasonPermissionDenied, "无法写入应用安装目录，请检查目录权限后重试安装。"},
		{prepStepVerify, kernel.UpdateReasonPermissionDenied, "无法读取已下载的更新文件，请检查权限或重新下载更新。"},
		{prepStepValidateLayout, kernel.UpdateReasonPermissionDenied, "无法读取已下载的更新文件，请检查权限或重新下载更新。"},
		{prepStepStartHelper, kernel.UpdateReasonPermissionDenied, "更新程序被系统或安全软件拦截，请允许 BeefTV 运行后重试，或下载安装包手动更新。"},
		{prepStepWaitPrepared, kernel.UpdateReasonPermissionDenied, "更新程序无权协同当前应用进程，请关闭应用后下载安装包手动更新，或以相同权限重试。"},
		{prepStepVerify, kernel.UpdateReasonFileNotFound, "更新文件缺失，可能被安全软件删除，请重新下载更新。"},
		{prepStepValidateLayout, kernel.UpdateReasonFileNotFound, "更新文件缺失，可能被安全软件删除，请重新下载更新。"},
		{prepStepCopyHelper, kernel.UpdateReasonFileNotFound, "更新程序缺失，可能被安全软件隔离，请将 BeefTV 加入白名单后重新下载安装。"},
		{prepStepStartHelper, kernel.UpdateReasonFileNotFound, "更新程序缺失，可能被安全软件隔离，请将 BeefTV 加入白名单后重新下载安装。"},
		{prepStepWaitPrepared, kernel.UpdateReasonFileNotFound, "更新所需文件缺失，请重新下载更新。"},
		{prepStepStage, kernel.UpdateReasonFileNotFound, "更新所需文件缺失，请重新下载更新。"},
		{prepStepStartHelper, kernel.UpdateReasonVirusBlocked, "更新程序被安全软件拦截，请将 BeefTV 加入白名单后重新下载安装。"},
		{prepStepStartHelper, kernel.UpdateReasonElevationRequired, "当前目录需要管理员权限才能更新，请以管理员身份运行后重试。"},
		{prepStepStartHelper, kernel.UpdateReasonPolicyBlocked, "系统策略阻止运行更新程序，请联系管理员或改用安装包手动更新。"},
		{prepStepStartHelper, kernel.UpdateReasonSharingViolation, "更新文件正被安全软件或其他程序占用，请稍后重试或关闭占用程序后再更新。"},
		{prepStepStartHelper, kernel.UpdateReasonLockViolation, "更新文件正被安全软件或其他程序占用，请稍后重试或关闭占用程序后再更新。"},
		{prepStepStartHelper, kernel.UpdateReasonFileBusy, "更新文件正被安全软件或其他程序占用，请稍后重试或关闭占用程序后再更新。"},
		{prepStepStage, kernel.UpdateReasonReadOnlyFS, "当前应用所在磁盘为只读状态，请移至可写目录后再更新。"},
		{prepStepWaitPrepared, kernel.UpdateReasonInstallLocked, "已有更新正在安装，请等待完成或重启应用后重试。"},
		{prepStepStage, kernel.UpdateReasonDataDirOverlap, "数据目录与程序目录重叠，请先将数据移到独立目录。"},
		{prepStepWaitPrepared, kernel.UpdateReasonInvalidArchive, ErrInvalidArchive.Error()},
		{prepStepWaitPrepared, kernel.UpdateReasonVerificationFailed, "更新文件损坏或被篡改。"},
		{prepStepWaitPrepared, kernel.UpdateReasonTimeout, ErrPreparationTimeout.Error()},
		{prepStepWaitPrepared, kernel.UpdateReasonUnsupported, ErrUnsupported.Error()},
		{prepStepWaitPrepared, kernel.UpdateReasonInvalidRequest, "更新准备参数无效，请重试安装。"},
		{prepStepWaitPrepared, kernel.UpdateReasonHelperExited, "安装准备失败，已保留下载内容，请重试安装。"},
	} {
		err := &prepError{step: tc.step, reason: tc.reason, err: errors.New("raw")}
		if got := publicInstallError(err); got != tc.want {
			t.Fatalf("publicInstallError(step=%s reason=%s) = %q, want %q", tc.step, tc.reason, got, tc.want)
		}
	}

	if got := kernel.ClassifyUpdateFailureText("another process has locked a portion of the file"); got != kernel.UpdateReasonLockViolation {
		t.Fatalf("lock violation English text classified as %q", got)
	}
	if got := kernel.ClassifyUpdateFailureText("The system cannot find the path specified."); got != kernel.UpdateReasonFileNotFound {
		t.Fatalf("path not found English text classified as %q", got)
	}

	// Verify wrapWaitPreparedError reads result.json (including ErrorCode) and helper.log fallbacks cleanly,
	// including when ErrPreparationTimeout raced with a recorded helper failure.
	dir := t.TempDir()
	resPath := filepath.Join(dir, "result.json")
	recBytes, _ := json.Marshal(RecoveryState{Status: "failed", Phase: "validate", Error: "write C:\\Users\\private\\prepared: 磁盘空间不足。", ErrorCode: kernel.Win32ErrorDiskFull})
	if err := os.WriteFile(resPath, recBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	wrapped := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, resPath, "")
	if meta := formatInstallFailureMeta(wrapped); meta != " step=wait_prepared reason=disk_full errno=112" {
		t.Fatalf("meta = %q", meta)
	}
	if isPreparationTimedOut(wrapped) {
		t.Fatalf("non-timeout exit should not report timedOut")
	}
	if got := publicInstallError(wrapped); got != wantDiskFull {
		t.Fatalf("publicInstallError(wrapped) = %q", got)
	}
	wrappedTimeoutRace := wrapWaitPreparedError(ErrPreparationTimeout, nil, resPath, "")
	if meta := formatInstallFailureMeta(wrappedTimeoutRace); meta != " step=wait_prepared reason=disk_full errno=112" {
		t.Fatalf("timeout race meta = %q", meta)
	}
	if !isPreparationTimedOut(wrappedTimeoutRace) || errors.Is(wrappedTimeoutRace, ErrPreparationTimeout) {
		t.Fatalf("timeout race must preserve timeout log flag without overriding concrete reason message: timedOut=%t isPrepTimeout=%t", isPreparationTimedOut(wrappedTimeoutRace), errors.Is(wrappedTimeoutRace, ErrPreparationTimeout))
	}
	if got := publicInstallError(wrappedTimeoutRace); got != wantDiskFull {
		t.Fatalf("publicInstallError(wrappedTimeoutRace) = %q", got)
	}

	logFallback := filepath.Join(dir, "helper.log")
	if err := os.WriteFile(logFallback, []byte("2026/01/01 open C:\\Users\\private\\request.json: 拒绝访问。\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedLog := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, filepath.Join(dir, "missing.json"), logFallback)
	if meta := formatInstallFailureMeta(wrappedLog); meta != " step=wait_prepared reason=permission_denied" {
		t.Fatalf("meta = %q", meta)
	}
	wrappedTimeoutLog := wrapWaitPreparedError(ErrPreparationTimeout, &os.PathError{Op: "open", Path: "x", Err: syscall.EACCES}, filepath.Join(dir, "missing.json"), logFallback)
	if want := fmt.Sprintf(" step=wait_prepared reason=permission_denied errno=%d", uint32(syscall.EACCES)); formatInstallFailureMeta(wrappedTimeoutLog) != want {
		t.Fatalf("timeout helper.log race meta = %q, want %q", formatInstallFailureMeta(wrappedTimeoutLog), want)
	}

	// Non-zh/en localized result.json message must still classify via numeric ErrorCode.
	localizedRes := filepath.Join(dir, "localized-result.json")
	var platformPermCode uint32
	if runtime.GOOS == "windows" {
		platformPermCode = kernel.Win32ErrorAccessDenied
	} else {
		platformPermCode = uint32(syscall.EACCES)
	}
	locBytes, _ := json.Marshal(RecoveryState{Status: "failed", Phase: "wait_parent", Error: "Zugriff verweigert", ErrorCode: platformPermCode})
	if err := os.WriteFile(localizedRes, locBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedLoc := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, localizedRes, "")
	if want := fmt.Sprintf(" step=wait_prepared reason=permission_denied errno=%d", platformPermCode); formatInstallFailureMeta(wrappedLoc) != want {
		t.Fatalf("localized numeric ErrorCode meta = %q, want %q", formatInstallFailureMeta(wrappedLoc), want)
	}

	// Real PathError EACCES wrapped with ErrInvalidArchive at validate_layout must
	// surface permission_denied and the read-side user message (not invalid_archive).
	layoutPermErr := wrapPrepError(prepStepValidateLayout, fmt.Errorf("%w: %w", ErrInvalidArchive, &os.PathError{Op: "open", Path: "/tmp/payload/x", Err: syscall.Errno(platformPermCode)}))
	if want := fmt.Sprintf(" step=validate_layout reason=permission_denied errno=%d", platformPermCode); formatInstallFailureMeta(layoutPermErr) != want {
		t.Fatalf("validate_layout permission meta = %q, want %q", formatInstallFailureMeta(layoutPermErr), want)
	}
	if got := publicInstallError(layoutPermErr); got != "无法读取已下载的更新文件，请检查权限或重新下载更新。" {
		t.Fatalf("publicInstallError(layoutPermErr) = %q", got)
	}

	// Oversized helper.log (>4 KiB) must classify from the tail so the fatal line is not missed.
	bigLog := filepath.Join(dir, "big-helper.log")
	bigContent := strings.Repeat("info: scanning update files...\n", 250) + "fatal: write failed: 磁盘空间不足。\n"
	if err := os.WriteFile(bigLog, []byte(bigContent), 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedBigLog := wrapWaitPreparedError(ErrPreparationTimeout, nil, filepath.Join(dir, "missing.json"), bigLog)
	if meta := formatInstallFailureMeta(wrappedBigLog); meta != " step=wait_prepared reason=disk_full" {
		t.Fatalf("big helper.log tail meta = %q", meta)
	}

	// Delta full-archive fallback network timeout must remain a network timeout, not preparation timeout.
	netTimeoutErr := wrapPrepError(prepStepExtract, failure(ErrTimeout, context.DeadlineExceeded, true))
	if got := publicInstallError(netTimeoutErr); got != ErrTimeout.Error() {
		t.Fatalf("publicInstallError(network ErrTimeout) = %q, want %q", got, ErrTimeout.Error())
	}

	// Helper-side FailureStep in RecoveryState must propagate so validation permission
	// failures render the read-side message instead of start_helper/wait_prepared copy.
	helperValRes := filepath.Join(dir, "helper-validate-result.json")
	valBytes, _ := json.Marshal(RecoveryState{
		Status:      "failed",
		Phase:       "validate",
		FailureStep: prepStepValidateLayout,
		Error:       "无法读取更新包文件: permission denied",
		ErrorCode:   platformPermCode,
	})
	if err := os.WriteFile(helperValRes, valBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedHelperVal := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, helperValRes, "")
	if want := fmt.Sprintf(" step=validate_layout reason=permission_denied errno=%d", platformPermCode); formatInstallFailureMeta(wrappedHelperVal) != want {
		t.Fatalf("helper validate FailureStep meta = %q, want %q", formatInstallFailureMeta(wrappedHelperVal), want)
	}
	if got := publicInstallError(wrappedHelperVal); got != "无法读取已下载的更新文件，请检查权限或重新下载更新。" {
		t.Fatalf("publicInstallError(wrappedHelperVal) = %q", got)
	}

	// Persisted FailureReason in RecoveryState is used directly without re-parsing localized text.
	directReasonRes := filepath.Join(dir, "direct-reason-result.json")
	directBytes, _ := json.Marshal(RecoveryState{
		Status:        "failed",
		Phase:         "validate",
		FailureStep:   prepStepWriteRequest,
		FailureReason: kernel.UpdateReasonPermissionDenied,
		Error:         "opaque localized error",
	})
	if err := os.WriteFile(directReasonRes, directBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedDirect := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, directReasonRes, "")
	if meta := formatInstallFailureMeta(wrappedDirect); meta != " step=write_request reason=permission_denied" {
		t.Fatalf("direct FailureReason meta = %q", meta)
	}
	if got := publicInstallError(wrappedDirect); got != "无法写入应用安装目录，请检查目录权限后重试安装。" {
		t.Fatalf("publicInstallError(wrappedDirect) = %q", got)
	}

	// When result.json could not be written, helper.log structured tokens recover step, reason, and errno.
	structLog := filepath.Join(dir, "structured-helper.log")
	if err := os.WriteFile(structLog, []byte("2026/11/20 18:45:00 step=write_request reason=permission_denied errno=5: rename C:\\Users\\private\\result.json: Access is denied.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedStructLog := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, filepath.Join(dir, "missing.json"), structLog)
	if meta := formatInstallFailureMeta(wrappedStructLog); meta != " step=write_request reason=permission_denied errno=5" {
		t.Fatalf("structured helper.log meta = %q", meta)
	}
	if got := publicInstallError(wrappedStructLog); got != "无法写入应用安装目录，请检查目录权限后重试安装。" {
		t.Fatalf("publicInstallError(wrappedStructLog) = %q", got)
	}

	// When result.json remained at status=prepared (e.g. disk filled while writing prepared),
	// helper.log structured tokens still recover step=write_request reason=disk_full errno=112.
	preparedRes := filepath.Join(dir, "prepared-result.json")
	prepBytes, _ := json.Marshal(RecoveryState{Status: "prepared", Phase: "wait_parent"})
	if err := os.WriteFile(preparedRes, prepBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	diskFullLog := filepath.Join(dir, "disk-full-helper.log")
	if err := os.WriteFile(diskFullLog, []byte("2026/11/20 18:45:01 step=write_request reason=disk_full errno=112: write prepared: disk full\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedDiskLog := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, preparedRes, diskFullLog)
	if meta := formatInstallFailureMeta(wrappedDiskLog); meta != " step=write_request reason=disk_full errno=112" {
		t.Fatalf("prepared-state helper.log fallback meta = %q", meta)
	}
	if got := publicInstallError(wrappedDiskLog); got != wantDiskFull {
		t.Fatalf("publicInstallError(wrappedDiskLog) = %q", got)
	}
}

func TestValidateLayoutPreservesRealPermissionCause(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("chmod 0000 permission test requires non-root unix")
	}
	payload := t.TempDir()
	if err := WriteDarwinLayout(payload, "NEW"); err != nil {
		t.Fatal(err)
	}
	macosDir := filepath.Join(payload, appBundleName, "Contents", "MacOS")
	if err := os.Chmod(macosDir, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(macosDir, 0o755) })

	err := validateExtractedLayout(payload, "darwin-arm64")
	if err == nil {
		t.Fatal("expected permission error from unreadable payload directory")
	}
	wrapped := wrapPrepError(prepStepValidateLayout, fmt.Errorf("%w: %w", ErrInvalidArchive, err))
	wantMeta := fmt.Sprintf(" step=validate_layout reason=permission_denied errno=%d", uint32(syscall.EACCES))
	if got := formatInstallFailureMeta(wrapped); got != wantMeta {
		t.Fatalf("meta = %q, want %q (raw=%v)", got, wantMeta, err)
	}
	if got := publicInstallError(wrapped); got != "无法读取已下载的更新文件，请检查权限或重新下载更新。" {
		t.Fatalf("publicInstallError = %q", got)
	}
}

func TestHelperLockPermissionAndNotFoundErrorsNotCollapsedToInstallLocked(t *testing.T) {
	t.Run("missing-target-parent-dir", func(t *testing.T) {
		root := t.TempDir()
		staged := filepath.Join(root, "payload")
		var platform, targetPath string
		if runtime.GOOS == "windows" {
			if err := WriteWindowsLayout(staged, "NEW"); err != nil {
				t.Fatal(err)
			}
			platform = "windows-amd64"
			targetPath = filepath.Join(root, "missing-dir", windowsExeName)
		} else {
			if err := WriteDarwinLayout(staged, "NEW"); err != nil {
				t.Fatal(err)
			}
			platform = "darwin-arm64"
			targetPath = filepath.Join(root, "missing-dir", appBundleName)
		}
		resPath := filepath.Join(root, "result.json")
		req := HelperRequest{
			Schema:       helperRequestSchema,
			ParentPID:    unusedPID(t),
			Platform:     platform,
			TargetPath:   targetPath,
			StagedPath:   staged,
			BackupPath:   filepath.Join(root, "backup"),
			PreparedPath: filepath.Join(root, "prepared"),
			ResultPath:   resPath,
		}
		err := RunHelperRequest(req)
		if err == nil {
			t.Fatal("expected lock failure on missing target parent directory")
		}
		if errors.Is(err, errInstallLockBusy) {
			t.Fatalf("ENOENT lock error misclassified as busy: %v", err)
		}
		wrapped := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, resPath, "")
		meta := formatInstallFailureMeta(wrapped)
		if !strings.Contains(meta, "step=stage reason=file_not_found errno=") {
			t.Fatalf("unexpected lock ENOENT meta: %q", meta)
		}
		if got := publicInstallError(wrapped); got != "更新所需文件缺失，请重新下载更新。" {
			t.Fatalf("publicInstallError = %q", got)
		}
	})

	t.Run("unwritable-target-dir-eacces", func(t *testing.T) {
		if runtime.GOOS == "windows" || os.Geteuid() == 0 {
			t.Skip("chmod 0500 directory lock test requires non-root unix")
		}
		root := t.TempDir()
		staged := filepath.Join(root, "payload")
		if err := WriteDarwinLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		targetDir := filepath.Join(root, "locked-dir")
		if err := os.MkdirAll(targetDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(targetDir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(targetDir, 0o700) })

		resPath := filepath.Join(root, "result.json")
		req := HelperRequest{
			Schema:       helperRequestSchema,
			ParentPID:    unusedPID(t),
			Platform:     "darwin-arm64",
			TargetPath:   filepath.Join(targetDir, appBundleName),
			StagedPath:   staged,
			BackupPath:   filepath.Join(root, "backup"),
			PreparedPath: filepath.Join(root, "prepared"),
			ResultPath:   resPath,
		}
		err := RunHelperRequest(req)
		if err == nil {
			t.Fatal("expected lock EACCES failure on read-only target dir")
		}
		if errors.Is(err, errInstallLockBusy) {
			t.Fatalf("EACCES lock error misclassified as busy: %v", err)
		}
		wrapped := wrapWaitPreparedError(&helperExitedError{err: errors.New("exit status 1")}, nil, resPath, "")
		wantMeta := fmt.Sprintf(" step=stage reason=permission_denied errno=%d", uint32(syscall.EACCES))
		if got := formatInstallFailureMeta(wrapped); got != wantMeta {
			t.Fatalf("meta = %q, want %q", got, wantMeta)
		}
		if got := publicInstallError(wrapped); got != "无法写入应用安装目录，请检查目录权限后重试安装。" {
			t.Fatalf("publicInstallError = %q", got)
		}
	})
}
