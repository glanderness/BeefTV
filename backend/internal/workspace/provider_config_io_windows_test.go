//go:build windows

package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsConfigReplaceErrorClassification(t *testing.T) {
	if !configFileInUse(windows.ERROR_SHARING_VIOLATION) {
		t.Fatal("expected ERROR_SHARING_VIOLATION to be treated as in-use")
	}
	if !configFileInUse(windows.ERROR_LOCK_VIOLATION) {
		t.Fatal("expected ERROR_LOCK_VIOLATION to be treated as in-use")
	}
	if !configFileInUse(windows.ERROR_USER_MAPPED_FILE) {
		t.Fatal("expected ERROR_USER_MAPPED_FILE to be treated as in-use")
	}
	if !configPermissionError(windows.ERROR_ACCESS_DENIED) {
		t.Fatal("expected ERROR_ACCESS_DENIED to be treated as permission error")
	}
	if !retryableConfigReplaceError(windows.ERROR_ACCESS_DENIED) {
		t.Fatal("expected ERROR_ACCESS_DENIED to be retryable on Windows rename")
	}

	origRename := renameConfigFile
	origSleep := sleepConfigRetry
	t.Cleanup(func() {
		renameConfigFile = origRename
		sleepConfigRetry = origSleep
	})
	sleepConfigRetry = func(time.Duration) {}
	renameConfigFile = func(oldpath, newpath string) error {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: windows.ERROR_ACCESS_DENIED}
	}

	err := wrapConfigIOError("替换本地模型配置失败", replaceConfigFile("tmp", "target"))
	if !errors.Is(err, ErrProviderConfigLocked) {
		t.Fatalf("err = %v, want ErrProviderConfigLocked", err)
	}
	if errors.Is(err, ErrProviderConfigPermission) {
		t.Fatalf("err = %v, must not be misclassified as ErrProviderConfigPermission", err)
	}
}

func TestWindowsConfigSaveRetriesAndMapsLockedPrimary(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"seed"}]}`)); err != nil {
		t.Fatal(err)
	}

	primaryPath := filepath.Join(dir, LocalProviderConfigFile)
	before, err := os.ReadFile(primaryPath)
	if err != nil {
		t.Fatal(err)
	}
	pathUTF16, err := windows.UTF16PtrFromString(primaryPath)
	if err != nil {
		t.Fatal(err)
	}
	// 打开只读共享但不共享删除的句柄，在 Windows 上会阻止 os.Rename 覆盖目标文件。
	handle, err := windows.CreateFile(
		pathUTF16,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		t.Fatalf("CreateFile lock failed: %v", err)
	}
	defer windows.CloseHandle(handle)

	origSleep := sleepConfigRetry
	t.Cleanup(func() { sleepConfigRetry = origSleep })
	sleepConfigRetry = func(time.Duration) {}

	err = store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"updated"}]}`))
	if !errors.Is(err, ErrProviderConfigLocked) {
		t.Fatalf("locked Windows save err = %v, want ErrProviderConfigLocked", err)
	}
	if errors.Is(err, ErrProviderConfigPermission) {
		t.Fatalf("locked Windows save err = %v, must not be ErrProviderConfigPermission", err)
	}
	requireFileUnchanged(t, primaryPath, before)
}
