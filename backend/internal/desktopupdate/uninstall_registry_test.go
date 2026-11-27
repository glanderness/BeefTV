package desktopupdate

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsUninstallRegistryNormalizationAndMatching(t *testing.T) {
	if got := normalizeWindowsDisplayVersion("v2.5.1"); got != "2.5.1" {
		t.Fatalf("normalizeWindowsDisplayVersion(v2.5.1) = %q, want 2.5.1", got)
	}
	if got := normalizeWindowsDisplayVersion("  2.5.0 "); got != "2.5.0" {
		t.Fatalf("normalizeWindowsDisplayVersion(2.5.0) = %q, want 2.5.0", got)
	}
	for _, invalid := range []string{"", "dev", "v2.5", "v2.5.0-beta.1"} {
		if got := normalizeWindowsDisplayVersion(invalid); got != "" {
			t.Fatalf("normalizeWindowsDisplayVersion(%q) = %q, want empty", invalid, got)
		}
	}

	if !windowsInstallLocationMatches(`"C:\Users\Alice\AppData\Local\Programs\BeefTV\"`, `c:/users/alice/appdata/local/programs/beeftv`) {
		t.Fatal("expected normalized Windows install paths to match across case, quotes, and slashes")
	}
	if windowsInstallLocationMatches(`C:\Users\Alice\AppData\Local\Programs\BeefTV`, `D:\Portable\BeefTV`) {
		t.Fatal("different install directories must not match")
	}
	if windowsInstallLocationMatches("", `C:\Users\Alice\AppData\Local\Programs\BeefTV`) {
		t.Fatal("empty InstallLocation must not match")
	}
}

func TestApplyWindowsUninstallDisplayVersionOnlyWhenInstallLocationMatches(t *testing.T) {
	var written string
	err := applyWindowsUninstallDisplayVersion(`C:\Users\Alice\AppData\Local\Programs\BeefTV`, "v2.5.1", windowsUninstallRegistryOps{
		readInstallLocation: func() (string, error) {
			return `c:\users\alice\appdata\local\programs\beeftv\`, nil
		},
		writeDisplayVersion: func(version string) error {
			written = version
			return nil
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if written != "2.5.1" {
		t.Fatalf("written DisplayVersion = %q, want 2.5.1", written)
	}

	// Mismatched InstallLocation (e.g. updating a portable copy) must never overwrite the installer registry entry.
	written = ""
	err = applyWindowsUninstallDisplayVersion(`D:\Portable\BeefTV`, "v2.5.1", windowsUninstallRegistryOps{
		readInstallLocation: func() (string, error) {
			return `C:\Users\Alice\AppData\Local\Programs\BeefTV`, nil
		},
		writeDisplayVersion: func(version string) error {
			written = version
			return nil
		},
	})
	if err != nil {
		t.Fatalf("unexpected error on mismatch: %v", err)
	}
	if written != "" {
		t.Fatalf("mismatched InstallLocation wrote DisplayVersion = %q", written)
	}

	// Read error stops before writing.
	readErr := errors.New("access denied")
	err = applyWindowsUninstallDisplayVersion(`C:\Users\Alice\AppData\Local\Programs\BeefTV`, "v2.5.1", windowsUninstallRegistryOps{
		readInstallLocation: func() (string, error) { return "", readErr },
		writeDisplayVersion: func(version string) error {
			written = version
			return nil
		},
	})
	if !errors.Is(err, readErr) || written != "" {
		t.Fatalf("err=%v written=%q, want readErr and no write", err, written)
	}
}

func TestRunHelperRequestUpdatesUninstallRegistryOnlyAfterRelaunchSucceeds(t *testing.T) {
	prevWait := acquireParentExitWait
	acquireParentExitWait = func(int) (func(time.Duration) error, func(), error) {
		return func(time.Duration) error { return nil }, func() {}, nil
	}
	t.Cleanup(func() { acquireParentExitWait = prevWait })

	var calls []struct {
		dir     string
		version string
	}
	prevSync := syncWindowsUninstallRegistryVersion
	syncWindowsUninstallRegistryVersion = func(dir, version string) error {
		calls = append(calls, struct {
			dir     string
			version string
		}{dir: dir, version: version})
		return errors.New("simulated registry write failure")
	}
	t.Cleanup(func() { syncWindowsUninstallRegistryVersion = prevSync })

	prevRelaunch := relaunchInstall
	t.Cleanup(func() { relaunchInstall = prevRelaunch })

	// 1. Successful swap + relaunch updates uninstall registry best-effort even when registry write errors.
	root := t.TempDir()
	targetDir := filepath.Join(root, "installed")
	stagedDir := filepath.Join(root, "staged")
	if err := WriteWindowsLayout(targetDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(stagedDir, "NEW"); err != nil {
		t.Fatal(err)
	}
	relaunchInstall = func(HelperRequest) error { return nil }
	req := HelperRequest{
		Schema:         helperRequestSchema,
		ParentPID:      12345,
		Platform:       "windows-amd64",
		TargetPath:     filepath.Join(targetDir, windowsExeName),
		StagedPath:     stagedDir,
		BackupPath:     filepath.Join(root, "backup"),
		ResultPath:     filepath.Join(root, "result.json"),
		TargetVersion:  "v2.5.1",
		WaitTimeoutSec: 5,
	}
	if err := RunHelperRequest(req); err != nil {
		t.Fatalf("RunHelperRequest failed despite best-effort registry sync: %v", err)
	}
	if len(calls) != 1 || calls[0].dir != targetDir || calls[0].version != "2.5.1" {
		t.Fatalf("unexpected registry sync calls: %+v", calls)
	}
	if got, err := os.ReadFile(req.TargetPath); err != nil || string(got) != "MZ-NEW" {
		t.Fatalf("target exe after update = %q err=%v, want MZ-NEW", got, err)
	}

	// 2. Failed relaunch triggers RestoreBackup and must NOT write the rolled-back new version to registry.
	calls = nil
	rollbackRoot := t.TempDir()
	rollbackTarget := filepath.Join(rollbackRoot, "installed")
	rollbackStaged := filepath.Join(rollbackRoot, "staged")
	if err := WriteWindowsLayout(rollbackTarget, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(rollbackStaged, "NEW"); err != nil {
		t.Fatal(err)
	}
	relaunchAttempts := 0
	relaunchInstall = func(HelperRequest) error {
		relaunchAttempts++
		if relaunchAttempts == 1 {
			return errors.New("simulated new binary launch failure")
		}
		return nil
	}
	rollbackReq := HelperRequest{
		Schema:         helperRequestSchema,
		ParentPID:      12345,
		Platform:       "windows-amd64",
		TargetPath:     filepath.Join(rollbackTarget, windowsExeName),
		StagedPath:     rollbackStaged,
		BackupPath:     filepath.Join(rollbackRoot, "backup"),
		ResultPath:     filepath.Join(rollbackRoot, "result.json"),
		TargetVersion:  "v2.5.2",
		WaitTimeoutSec: 5,
	}
	if err := RunHelperRequest(rollbackReq); err == nil {
		t.Fatal("expected RunHelperRequest failure when relaunch fails")
	}
	if len(calls) != 0 {
		t.Fatalf("rolled-back update must not sync uninstall registry, got %+v", calls)
	}
	if got, err := os.ReadFile(rollbackReq.TargetPath); err != nil || string(got) != "MZ-OLD" {
		t.Fatalf("target exe after rollback = %q err=%v, want MZ-OLD", got, err)
	}
}
