package desktopupdate

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
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

func TestSwapWindowsUpdatesUninstallRegistryBestEffort(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "installed")
	stagedDir := filepath.Join(root, "staged")
	if err := WriteWindowsLayout(targetDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(stagedDir, "NEW"); err != nil {
		t.Fatal(err)
	}

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

	req := HelperRequest{
		Platform:      "windows-amd64",
		TargetPath:    filepath.Join(targetDir, windowsExeName),
		StagedPath:    stagedDir,
		BackupPath:    filepath.Join(root, "backup"),
		TargetVersion: "v2.5.1",
	}
	// Registry write error must remain best-effort and never fail or roll back a successful swap.
	if err := SwapInstall(req); err != nil {
		t.Fatalf("SwapInstall failed despite best-effort registry sync: %v", err)
	}
	if len(calls) != 1 || calls[0].dir != targetDir || calls[0].version != "2.5.1" {
		t.Fatalf("unexpected registry sync calls: %+v", calls)
	}
	if got, err := os.ReadFile(req.TargetPath); err != nil || string(got) != "MZ-NEW" {
		t.Fatalf("target exe after swap = %q err=%v, want MZ-NEW", got, err)
	}

	// Failed swap must never touch uninstall registry.
	calls = nil
	badStaged := filepath.Join(root, "bad-staged")
	if err := WriteWindowsLayout(badStaged, "BAD"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(badStaged, "agent-host", "runtime", "node.exe")); err != nil {
		t.Fatal(err)
	}
	failReq := HelperRequest{
		Platform:      "windows-amd64",
		TargetPath:    filepath.Join(targetDir, windowsExeName),
		StagedPath:    badStaged,
		BackupPath:    filepath.Join(root, "backup-2"),
		TargetVersion: "v2.5.2",
	}
	if err := SwapInstall(failReq); err == nil {
		t.Fatal("expected SwapInstall failure for invalid staged layout")
	}
	if len(calls) != 0 {
		t.Fatalf("failed swap must not sync uninstall registry, got %+v", calls)
	}
}
