package diagnostics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUpdateLogWindowRotationAndPrivacy(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	line := func(offset time.Duration, message string) string {
		return now.Add(offset).Format(time.RFC3339) + " v1.7.20 " + message + "\n"
	}
	previous := line(-time.Minute, "update phase=extracting") + line(-time.Hour, "update phase=downloading")
	current := line(0, "install failure phase=extracting completedFiles=34 totalFiles=15000 timeout=true") +
		line(0, `install preparation failed: open C:\Users\private-user\secret.zip: permission denied token=private-token`) +
		line(0, "download start size=123 resumeFrom=10 route=proxy private-host:1080") +
		line(0, "download attempt=2 failed: connection reset private-host") +
		line(time.Hour, "update phase=restarting") +
		line(0, "unrecognized private-payload")
	for name, data := range map[string]string{"update.log.1": previous, "update.log": current} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	window := timeWindow{From: now.Add(-2 * time.Minute), To: now}
	log := collectUpdateLog(dir, window)
	if log.Status != "available" || log.Lines != 5 {
		t.Fatalf("%+v", log)
	}
	for _, forbidden := range []string{"private", "secret", "downloading", "restarting", "token="} {
		if strings.Contains(log.Text, forbidden) {
			t.Fatalf("leaked %s: %s", forbidden, log.Text)
		}
	}
	if !strings.Contains(log.Text, "permission-denied") || !strings.Contains(log.Text, "completedFiles=34") {
		t.Fatal(log.Text)
	}
	data, err := buildZIP("BeefTV", "test", manifest{}, &collection{Window: window, UpdateLog: log})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, data)
	if files["desktop/update.log"] != log.Text || !strings.Contains(files["desktop/update-log.json"], `"lines": 5`) {
		t.Fatal(files)
	}
}

func TestUpdateLogMissingUnreadableAndBounded(t *testing.T) {
	dir := t.TempDir()
	window := timeWindow{From: time.Now().Add(-time.Hour), To: time.Now().Add(time.Hour)}
	if collectUpdateLog("", window) != nil || collectUpdateLog(dir, window).Status != "missing" {
		t.Fatal("missing log should not fail export")
	}
	path := filepath.Join(dir, "update.log")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if collectUpdateLog(dir, window).Status != "unreadable" {
		t.Fatal("non-regular log accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	line := time.Now().UTC().Format(time.RFC3339) + " v1.7.20 update phase=extracting\n"
	if err := os.WriteFile(path, []byte(strings.Repeat(line, 10000)), 0600); err != nil {
		t.Fatal(err)
	}
	log := collectUpdateLog(dir, window)
	if !log.Truncated || log.Lines == 0 || len(log.Text) > updateLogLimit {
		t.Fatalf("%+v", log)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("private", updateLogLimit)+"\n"+line), 0600); err != nil {
		t.Fatal(err)
	}
	log = collectUpdateLog(dir, window)
	if !log.Truncated || log.Text != line || log.Lines != 1 {
		t.Fatalf("lost line after oversized error: %+v", log)
	}
}

func TestUpdateLogStructuredPrepFailureAndLocalizedRedaction(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 20, 8, 0, 0, 0, time.UTC)
	line := func(message string) string {
		return now.Format(time.RFC3339) + " v2.3.2 " + message + "\n"
	}
	content := strings.Join([]string{
		line("install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=start_helper reason=sharing_violation errno=32"),
		line(`install preparation failed: step=start_helper reason=sharing_violation errno=32: fork/exec C:\Users\private-user\AppData\Local\BeefTV\.beeftv-update-1\BeefTV-update-helper.exe: 另一个程序正在使用此文件 token=private-token https://user:secret@example.com/path`),
		line("install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=install_locked exitCode=1"),
		line(`install preparation failed: step=wait_prepared reason=install_locked exitCode=1: helper exited before signaling prepared: exit status 1`),
		// Windows 64-bit NTSTATUS exit code (0xC0000005 = 3221225477) and negative Unix signal exit code.
		line("install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=helper_exited exitCode=3221225477"),
		line(`install preparation failed: step=wait_prepared reason=helper_exited exitCode=3221225477: helper exited before signaling prepared: exit status 0xc0000005`),
		line("install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=helper_exited exitCode=-9"),
		line("install failure phase=extracting completedFiles=12 totalFiles=100 timeout=false step=extract reason=disk_full errno=112"),
		line(`install preparation failed: write C:\Users\private-user\AppData\file: 磁盘空间不足。`),
		line(`install preparation failed: write C:\Users\private-user\AppData\file: There is not enough space on the disk.`),
		line(`install preparation failed: open C:\Users\private-user\AppData\file: 拒绝访问。`),
		line(`install preparation failed: fork/exec C:\Users\private-user\helper.exe: 另一个程序正在使用此文件，进程无法访问。`),
		line(`install preparation failed: 更新包格式无效: 更新包缺少 BeefTV.exe`),
		line(`install preparation failed: open C:\Users\private-user\mystery.bin: mysterious localized failure token=private-token`),
		// Safe operational degradation notices pass through without leaking details.
		line("install helper log unavailable"),
		line("install helper did not exit; update files retained"),
		line("install update files retained after cleanup failure"),
		line(`install helper stopped: step=wait_prepared reason=timeout errno=32 exitCode=1: exit status 1 C:\Users\private-user\helper.log`),
		// Unknown/unsafe tokens on install failure are stripped while preserving the safe base and any valid tokens.
		line(`install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=start_helper path=C:\Users\private-user futureField=private-val`),
		line(`install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=private_step reason=sharing_violation`),
		line(`install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=private_step reason=private_reason`),
	}, "")
	if err := os.WriteFile(filepath.Join(dir, "update.log"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	window := timeWindow{From: now.Add(-time.Minute), To: now.Add(time.Minute)}
	log := collectUpdateLog(dir, window)
	if log.Status != "available" || log.Lines != 21 {
		t.Fatalf("unexpected summary: %+v\n%s", log, log.Text)
	}
	for _, forbidden := range []string{"private", "secret", "token=", "example.com", `C:\Users`, "AppData", "BeefTV-update-helper", "mystery.bin", "futureField"} {
		if strings.Contains(log.Text, forbidden) {
			t.Fatalf("leaked %q in redacted update log:\n%s", forbidden, log.Text)
		}
	}
	for _, expected := range []string{
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=start_helper reason=sharing_violation errno=32\n",
		"install preparation failed: step=start_helper reason=sharing_violation errno=32\n",
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=install_locked exitCode=1\n",
		"install preparation failed: step=wait_prepared reason=install_locked exitCode=1\n",
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=helper_exited exitCode=3221225477\n",
		"install preparation failed: step=wait_prepared reason=helper_exited exitCode=3221225477\n",
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=wait_prepared reason=helper_exited exitCode=-9\n",
		"install failure phase=extracting completedFiles=12 totalFiles=100 timeout=false step=extract reason=disk_full errno=112\n",
		"install preparation failed: disk-full\n",
		"install preparation failed: permission-denied\n",
		"install preparation failed: sharing-violation\n",
		"install preparation failed: invalid-archive\n",
		"install preparation failed: details-redacted\n",
		"install helper log unavailable\n",
		"install helper did not exit; update files retained\n",
		"install update files retained after cleanup failure\n",
		"install helper stopped: step=wait_prepared reason=timeout errno=32 exitCode=1\n",
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false step=start_helper\n",
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false reason=sharing_violation\n",
		"install failure phase=preparing completedFiles=0 totalFiles=0 timeout=false\n",
	} {
		if !strings.Contains(log.Text, expected) {
			t.Fatalf("missing expected line %q in:\n%s", expected, log.Text)
		}
	}
	if strings.Count(log.Text, "install preparation failed: disk-full\n") != 2 {
		t.Fatalf("expected both zh-CN and English disk-full lines:\n%s", log.Text)
	}
}
