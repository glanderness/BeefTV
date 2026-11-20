package desktopupdate

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// A copied test executable is a real PE launch target for the Windows
	// replacement test, without recursively running this test suite.
	if os.Getenv("BEEFTV_UPDATER_TEST_LAUNCH") == "1" && len(os.Args) == 1 {
		os.Exit(0)
	}
	if os.Getenv("BEEFTV_UPDATER_TEST_HANG_HELPER") == "1" {
		if _, found := helperRequestArg(os.Args); found {
			time.Sleep(30 * time.Second)
			os.Exit(0)
		}
	}
	if done, err := HandleHelperCommand(os.Args); done {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestHandleHelperCommandIgnoresNormalArgs(t *testing.T) {
	done, err := HandleHelperCommand([]string{"BeefTV"})
	if done || err != nil {
		t.Fatalf("done=%v err=%v", done, err)
	}
}

func TestHandleHelperCommandRequiresRequestPath(t *testing.T) {
	done, err := HandleHelperCommand([]string{"BeefTV", helperFlag})
	if !done || err == nil {
		t.Fatalf("done=%v err=%v", done, err)
	}
}

func TestSpawnedHelperReplacesInstall(t *testing.T) {
	root := t.TempDir()
	oldDir := filepath.Join(root, "old")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(oldDir, ".beeftv-update-")
	if err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(work, "payload")
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:         1,
		ParentPID:      unusedPID(t),
		Platform:       "darwin-arm64",
		TargetPath:     filepath.Join(oldDir, appBundleName),
		StagedPath:     staged,
		BackupPath:     filepath.Join(work, "backup"),
		PreparedPath:   filepath.Join(work, "prepared"),
		ResultPath:     filepath.Join(work, "result.json"),
		WaitTimeoutSec: 5,
	}
	if runtime.GOOS == "windows" {
		if err := WriteWindowsLayout(oldDir, "OLD"); err != nil {
			t.Fatal(err)
		}
		// Remove the Darwin fixture before validating the Windows archive layout.
		if err := os.RemoveAll(filepath.Join(staged, appBundleName)); err != nil {
			t.Fatal(err)
		}
		if err := WriteWindowsLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(staged, windowsExeName)); err != nil {
			t.Fatal(err)
		}
		if err := copyFile(exe, filepath.Join(staged, windowsExeName)); err != nil {
			t.Fatal(err)
		}
		req.Platform = "windows-amd64"
		req.TargetPath = filepath.Join(oldDir, windowsExeName)
		t.Setenv("BEEFTV_UPDATER_TEST_LAUNCH", "1")
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(work, "request.json")
	if err := os.WriteFile(requestPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	helperPath := filepath.Join(work, "BeefTV-update-helper")
	if runtime.GOOS == "windows" {
		helperPath += ".exe"
	}
	if err := copyFile(exe, helperPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(helperPath, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(helperPath, helperFlag, requestPath)
	cmd.Dir = work
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper: %v\n%s", err, out)
	}
	installed := filepath.Join(req.TargetPath, "Contents", "MacOS", "BeefTV")
	if runtime.GOOS == "windows" {
		installed = filepath.Join(oldDir, pluginDirName, "official.beeftv-plugin")
	}
	got, err := os.ReadFile(installed)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("installed = %q helper=%s", got, out)
	}
	if !pathExists(req.BackupPath) {
		t.Fatal("process launch alone discarded the recovery copy")
	}
	if err := cleanupCompletedUpdates(Target{Path: req.TargetPath, Platform: req.Platform}, ""); err != nil {
		t.Fatal(err)
	}
	if pathExists(work) || (runtime.GOOS == "windows" && pathExists(filepath.Join(oldDir, ".BeefTV.update.lock"))) {
		t.Fatal("confirmed startup retained update files")
	}
}

func unusedPID(t *testing.T) int {
	t.Helper()
	return 987654321
}

func TestRunHelperRequestAbortsBeforePreparedWhenRecoveryWriteFails(t *testing.T) {
	root := t.TempDir()
	var (
		platform   string
		targetPath string
		staged     string
	)
	staged = filepath.Join(root, "payload")
	if runtime.GOOS == "windows" {
		if err := WriteWindowsLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		if err := WriteWindowsLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		platform = "windows-amd64"
		targetPath = filepath.Join(root, windowsExeName)
	} else {
		if err := WriteDarwinLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		if err := WriteDarwinLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		platform = "darwin-arm64"
		targetPath = filepath.Join(root, appBundleName)
	}
	// Make ResultPath an existing non-empty directory so atomic rename into ResultPath fails.
	badResultDir := filepath.Join(root, "result-is-dir")
	if err := os.MkdirAll(badResultDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badResultDir, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	preparedPath := filepath.Join(root, "prepared")
	req := HelperRequest{
		Schema:         helperRequestSchema,
		ParentPID:      unusedPID(t),
		Platform:       platform,
		TargetPath:     targetPath,
		StagedPath:     staged,
		BackupPath:     filepath.Join(root, "backup"),
		PreparedPath:   preparedPath,
		ResultPath:     badResultDir,
		WaitTimeoutSec: 5,
	}
	err := RunHelperRequest(req)
	if err == nil {
		t.Fatal("expected RunHelperRequest to fail when pre-prepared result.json cannot be persisted")
	}
	if pathExists(preparedPath) {
		t.Fatal("prepared marker must not be written when pre-prepared result.json write fails")
	}
	if meta := formatInstallFailureMeta(err); !strings.HasPrefix(meta, " step=write_request ") {
		t.Fatalf("expected write_request structured error, got meta=%q err=%v", meta, err)
	}
	logStep, logReason, _, _ := classifyHelperLog("2026/11/20 18:45:00 " + err.Error() + "\n")
	if logStep != prepStepWriteRequest || !logReason.Valid() {
		t.Fatalf("classifyHelperLog(%q) = (%q, %q)", err.Error(), logStep, logReason)
	}
}

func TestRunHelperRequestAbortsBeforeSwapWhenAbortedMarkerPresent(t *testing.T) {
	root := t.TempDir()
	work, err := os.MkdirTemp(root, ".beeftv-update-")
	if err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(work, "payload")
	var platform, targetPath, installed string
	if runtime.GOOS == "windows" {
		if err := WriteWindowsLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		if err := WriteWindowsLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		platform = "windows-amd64"
		targetPath = filepath.Join(root, windowsExeName)
		installed = filepath.Join(root, pluginDirName, "official.beeftv-plugin")
	} else {
		if err := WriteDarwinLayout(root, "OLD"); err != nil {
			t.Fatal(err)
		}
		if err := WriteDarwinLayout(staged, "NEW"); err != nil {
			t.Fatal(err)
		}
		platform = "darwin-arm64"
		targetPath = filepath.Join(root, appBundleName)
		installed = filepath.Join(targetPath, "Contents", "MacOS", "BeefTV")
	}
	if err := os.WriteFile(filepath.Join(work, abortedMarkerName), []byte("aborted\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:         helperRequestSchema,
		ParentPID:      unusedPID(t),
		Platform:       platform,
		TargetPath:     targetPath,
		StagedPath:     staged,
		BackupPath:     filepath.Join(work, "backup"),
		PreparedPath:   filepath.Join(work, "prepared"),
		ResultPath:     filepath.Join(work, "result.json"),
		WaitTimeoutSec: 5,
	}
	if err := RunHelperRequest(req); err == nil {
		t.Fatal("expected aborted helper to refuse preparation and swap")
	}
	if pathExists(req.PreparedPath) || pathExists(req.BackupPath) {
		t.Fatal("aborted helper must not create prepared marker or backup")
	}
	got, err := os.ReadFile(installed)
	if err != nil || !strings.Contains(string(got), "OLD") {
		t.Fatalf("installed payload modified despite aborted marker: got=%q err=%v", got, err)
	}
}
