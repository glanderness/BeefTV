package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

func TestStagingNeverDeletesAnotherDownload(t *testing.T) {
	e := &Engine{stagingRoot: t.TempDir()}
	first, err := e.prepareStaging("v1.5.2")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(first, "keep")
	if err := os.WriteFile(marker, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := e.prepareStaging("v1.5.2")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("staging directory reused")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("other download removed", err)
	}
}

func TestInstallLockExcludesConcurrentHelperAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	release, err := lockInstall(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := lockInstall(path)
	if err == nil {
		second()
		release()
		t.Fatal("concurrent lock acquired")
	}
	release()
	third, err := lockInstall(path)
	if err != nil {
		t.Fatal(err)
	}
	third()
}

func TestSuccessfulLaunchRetainsOldProgramForRecovery(t *testing.T) {
	root := t.TempDir()
	old, stage := filepath.Join(root, "old"), filepath.Join(root, "stage")
	if err := WriteDarwinLayout(old, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(stage, "NEW"); err != nil {
		t.Fatal(err)
	}
	original := relaunchInstall
	relaunchInstall = func(HelperRequest) error { return nil }
	defer func() { relaunchInstall = original }()
	req := HelperRequest{Schema: 1, ParentPID: unusedPID(t), Platform: "darwin-arm64", TargetPath: filepath.Join(old, appBundleName), StagedPath: stage, BackupPath: filepath.Join(root, "backup")}
	if err := RunHelperRequest(req); err != nil {
		t.Fatal(err)
	}
	kept, err := os.ReadFile(filepath.Join(req.BackupPath, "Contents", "MacOS", "BeefTV"))
	if err != nil || !strings.Contains(string(kept), "OLD") {
		t.Fatalf("backup lost: %v", err)
	}
}

func TestInstallRechecksArchiveAndRejectsEmbeddedData(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	target := Target{Path: filepath.Join(root, appBundleName)}
	e := &Engine{locate: func() (Target, error) { return target, nil }}
	archive := filepath.Join(root, "update.zip")
	if err := os.WriteFile(archive, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	stage := &stagedUpdate{archive: archive, artifact: PlatformArtifact{Size: 8, SHA256: strings.Repeat("0", 64)}}
	if err := e.prepareAndStartHelper(context.Background(), stage); !errors.Is(err, ErrTampered) {
		t.Fatalf("err=%v", err)
	}
	e.dataDir = filepath.Join(target.Path, "userdata")
	if err := e.prepareAndStartHelper(context.Background(), stage); err == nil || !strings.Contains(err.Error(), "数据目录") {
		t.Fatalf("err=%v", err)
	}
	data, err := os.ReadFile(filepath.Join(target.Path, "Contents", "MacOS", "BeefTV"))
	if err != nil || !strings.Contains(string(data), "OLD") {
		t.Fatal("old program changed")
	}
}

func TestRejectWindowsAliasesAndOverflowVersions(t *testing.T) {
	for _, name := range []string{"BeefTV.exe:payload", "plugin-packages/NUL.txt", "x/COM1", "x/name.", "x/name /file"} {
		if _, _, err := sanitizeZipName(name); err == nil {
			t.Errorf("accepted %q", name)
		}
	}
	if _, err := parseStableVersion("v999999999999999999999999999.1.1"); err == nil {
		t.Fatal("overflow accepted")
	}
	var dst any
	if err := decodeJSONStrict([]byte(`{} {}`), &dst); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}

func TestWindowsInstallRejectsCollocatedUserData(t *testing.T) {
	root := t.TempDir()
	if err := WriteWindowsLayout(root, "OLD"); err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(root, pluginDirName, "custom.beeftv-plugin")
	if err := os.WriteFile(custom, []byte("uploaded"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := Target{Platform: "windows-amd64", Path: filepath.Join(root, windowsExeName)}
	e := &Engine{dataDir: root, locate: func() (Target, error) { return target, nil }}
	if err := e.prepareAndStartHelper(context.Background(), &stagedUpdate{platform: "windows-amd64"}); err == nil || !strings.Contains(err.Error(), "数据目录") {
		t.Fatalf("err=%v", err)
	}
	data, err := os.ReadFile(custom)
	if err != nil || string(data) != "uploaded" {
		t.Fatal("custom plugin changed")
	}
}

func TestHelperExitWhileParentAliveMakesInstallRetryable(t *testing.T) {
	done := make(chan error, 1)
	waiter := startHelperWaiter(func() error { return <-done })
	e := &Engine{state: UpdateState{Status: StatusInstalling}, helperWait: waiter}
	e.monitorHelper()
	done <- errors.New("等待应用退出超时")
	deadline := time.Now().Add(time.Second)
	for e.Status().Status == StatusInstalling && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if e.Status().Status != StatusError {
		t.Fatal("install remained stuck")
	}
	if err := e.begin(actionCheck); err != nil {
		t.Fatalf("retry blocked: %v", err)
	}
	e.end()
	// A concurrent/late killHelper observing the same completed helperWaiter must
	// never deadlock even after monitorHelper already consumed the completion.
	if err, exited := terminateHelperWaiter(nil, waiter, time.Second, nil); !exited || err == nil {
		t.Fatalf("terminateHelperWaiter on completed waiter = (%v, %t), want (err, true)", err, exited)
	}
}

func TestPostPrepareAbandonedWorkDirReclaimedOnQuitFailAndHelperStop(t *testing.T) {
	t.Run("quit-fail-kills-helper-and-reclaims-workdir", func(t *testing.T) {
		root := t.TempDir()
		platform, targetPath, archive, data := writeNativeSubprocessFixture(t, root)
		sum := sha256.Sum256(data)

		engine := &Engine{
			enabled:        true,
			currentVersion: "v2.3.2",
			logPath:        filepath.Join(t.TempDir(), "update.log"),
			parentPID:      os.Getpid(),
			staged: &stagedUpdate{
				version:  "v2.3.3",
				archive:  archive,
				platform: platform,
				artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])},
			},
			locate: func() (Target, error) {
				return Target{Path: targetPath, Platform: platform}, nil
			},
			quit: func() error {
				return errors.New("quit vetoed")
			},
		}

		if err := engine.InstallUpdate(context.Background()); err == nil {
			t.Fatal("expected quit failure")
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".beeftv-update-") {
				t.Fatalf("workDir leaked after quit failure: %s", entry.Name())
			}
		}
	})

	t.Run("monitor-reclaims-without-backup-and-preserves-with-backup", func(t *testing.T) {
		noBackupDir := filepath.Join(t.TempDir(), ".beeftv-update-nobackup")
		if err := os.MkdirAll(filepath.Join(noBackupDir, "payload"), 0o700); err != nil {
			t.Fatal(err)
		}
		writeCleanupJSON(t, filepath.Join(noBackupDir, "result.json"), RecoveryState{
			Status:        "failed",
			Phase:         "wait_parent",
			FailureStep:   prepStepWaitPrepared,
			FailureReason: kernel.UpdateReasonTimeout,
			ErrorCode:     kernel.Win32ErrorSharingViolation,
			Error:         "等待应用退出超时",
		})
		logPath := filepath.Join(t.TempDir(), "update.log")
		done1 := make(chan error, 1)
		e1 := &Engine{
			currentVersion: "v2.3.2",
			logPath:        logPath,
			state:          UpdateState{Status: StatusInstalling},
			helperWait:     startHelperWaiter(func() error { return <-done1 }),
			helperWorkDir:  noBackupDir,
		}
		e1.monitorHelper()
		done1 <- errors.New("等待应用退出超时")
		deadline := time.Now().Add(2 * time.Second)
		for pathExists(noBackupDir) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if pathExists(noBackupDir) {
			t.Fatalf("abandoned workDir without backup was not reclaimed: %s", noBackupDir)
		}
		rawLog, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(rawLog), "install helper stopped: step=wait_prepared reason=timeout errno=32:") {
			t.Fatalf("monitorHelper lost structured result.json metadata before cleanup:\n%s", rawLog)
		}

		withBackupDir := filepath.Join(t.TempDir(), ".beeftv-update-withbackup")
		backupMarker := filepath.Join(withBackupDir, "backup", "old-program")
		if err := os.MkdirAll(filepath.Dir(backupMarker), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(backupMarker, []byte("recovery"), 0o600); err != nil {
			t.Fatal(err)
		}
		done2 := make(chan error, 1)
		e2 := &Engine{
			state:         UpdateState{Status: StatusInstalling},
			helperWait:    startHelperWaiter(func() error { return <-done2 }),
			helperWorkDir: withBackupDir,
		}
		e2.monitorHelper()
		done2 <- nil
		deadline = time.Now().Add(2 * time.Second)
		for e2.Status().Status == StatusInstalling && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if !pathExists(backupMarker) {
			t.Fatal("monitorHelper must never delete a workDir that holds a recovery backup")
		}
	})
}
