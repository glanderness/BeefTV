package assistantruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
)

const fixtureEnv = "BEEFTV_ASSISTANT_RUNTIME_FIXTURE"

func TestMain(m *testing.M) {
	if mode := strings.TrimSpace(os.Getenv(fixtureEnv)); mode != "" {
		os.Exit(runProcessFixture(mode))
	}
	os.Exit(m.Run())
}

func runProcessFixture(mode string) int {
	switch mode {
	case "sleep":
		waitForStopSignal()
		return 0
	case "exit0":
		return 0
	case "crash":
		return 2
	default:
		fmt.Fprintf(os.Stderr, "unknown fixture %q\n", mode)
		return 1
	}
}

func fixtureProvider() app.AssistantProvider {
	return app.AssistantProvider{Model: "m", BaseURL: "https://example.invalid/v1", APIKey: "k", Protocol: "chat-completion"}
}

func waitForStopSignal() {
	notified := make(chan os.Signal, 1)
	signal.Notify(notified, os.Interrupt, syscall.SIGTERM)
	<-notified
}

func fixtureHost(t *testing.T, mode string) *Host {
	t.Helper()
	dataDir := t.TempDir()
	config := HostConfig{HostCommand: os.Args[0], HostArgs: []string{}}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, hostConfigFile), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir: dataDir,
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"="+mode)
		},
	})
	t.Cleanup(func() { _ = host.Stop() })
	return host
}

func waitUntil(timeout time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ok()
}

func TestHostStopReapsOwnChild(t *testing.T) {
	host := fixtureHost(t, "sleep")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("启动测试宿主失败: %v", err)
	}
	if host.PID() == 0 || !host.Running() {
		t.Fatal("子进程应处于运行状态")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := host.StopContext(ctx); err != nil {
		t.Fatalf("关闭钩子应成功停止本 Host 启动的宿主: %v", err)
	}
	if host.Running() {
		t.Fatal("停止后不应仍报告运行中")
	}
	if err := host.StopContext(context.Background()); err != nil {
		t.Fatalf("无自有宿主时钩子应为 no-op，实际 %v", err)
	}
}

func TestHostRestartReplacesChild(t *testing.T) {
	host := fixtureHost(t, "sleep")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	if first == 0 {
		t.Fatal("未记录子进程 PID")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("重启失败: %v", err)
	}
	if !host.Running() {
		t.Fatal("重启后应有新的子进程")
	}
	second := host.PID()
	if second == 0 || second == first {
		t.Fatalf("重启应换新 PID，first=%d second=%d", first, second)
	}
}

func TestHostCrashIsReapedAndCanRelaunch(t *testing.T) {
	host := fixtureHost(t, "crash")
	provider := fixtureProvider()
	for attempt := 0; attempt < 2; attempt++ {
		if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
			t.Fatal(err)
		}
		if !waitUntil(5*time.Second, func() bool { return !host.Running() }) {
			t.Fatal("崩溃子进程应被唯一的 Wait 回收")
		}
	}
}

func TestSeparateHostsDoNotShareProcessOwnership(t *testing.T) {
	first := fixtureHost(t, "sleep")
	second := fixtureHost(t, "sleep")
	provider := fixtureProvider()
	if err := first.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if err := second.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	firstPID, secondPID := first.PID(), second.PID()
	if firstPID == 0 || secondPID == 0 || firstPID == secondPID {
		t.Fatalf("两个 Host 应各自持有子进程 first=%d second=%d", firstPID, secondPID)
	}
	if err := first.Stop(); err != nil {
		t.Fatal(err)
	}
	if first.Running() {
		t.Fatal("停止 first 后其自身不应仍在运行")
	}
	if !second.Running() || second.PID() != secondPID {
		t.Fatal("停止 first 不得带走 second 的子进程")
	}
}

func TestEnsureRestartsWhenFingerprintChangesAndIdle(t *testing.T) {
	host := fixtureHost(t, "sleep")
	original := fixtureProvider()
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	updated := original
	updated.APIKey = "rotated"
	launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !launched {
		t.Fatal("空闲且指纹变化时应重启")
	}
	if host.PID() == first {
		t.Fatal("指纹变化重启应换新 PID")
	}
	launched, err = host.Ensure(updated, "http://127.0.0.1:18090/api", "", true)
	if err != nil || launched {
		t.Fatalf("相同指纹且在跑时 Ensure 应为 no-op launched=%v err=%v", launched, err)
	}
}

func TestEnsureDoesNotRestartBusyHostOnFingerprintChange(t *testing.T) {
	host := fixtureHost(t, "sleep")
	original := fixtureProvider()
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	updated := original
	updated.Model = "other"
	launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if launched {
		t.Fatal("非空闲时不得因指纹变化重启")
	}
	if host.PID() != first {
		t.Fatal("非空闲时 PID 应保持不变")
	}
}

func fixtureExitName() string {
	if runtime.GOOS == "windows" {
		return "host.cmd"
	}
	return "host.sh"
}

func fixtureExitSource() string {
	if runtime.GOOS == "windows" {
		return "@echo off\r\nexit 0\r\n"
	}
	return "#!/bin/sh\nexit 0\n"
}

func startOutsider(t *testing.T) *exec.Cmd {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "120", "127.0.0.1")
	} else {
		cmd = exec.Command("sleep", "120")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd
}
