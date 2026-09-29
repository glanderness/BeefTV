package handler

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 宿主把 BEEFTV_OPS_URL 当基址再拼 /ops，因此这里必须带 /api 前缀；
// 少了它宿主启动即因 404 退出，界面只会显示「创作助手暂时不可用」。
func TestHostEnvOpsURLKeepsAPIPrefix(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "agent_host_token"), []byte("host-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "agent_owner_token"), []byte("owner-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CANVAS_BACKEND_ADDR", "127.0.0.1:18090")
	t.Setenv("CANVAS_BACKEND_PORT", "")

	env := hostEnv(dataDir, "gpt-5.5", "https://beefapi.com/v1")
	value := func(key string) string {
		prefix := key + "="
		for _, entry := range env {
			if strings.HasPrefix(entry, prefix) {
				return strings.TrimPrefix(entry, prefix)
			}
		}
		return ""
	}

	if got := value("BEEFTV_OPS_URL"); got != "http://127.0.0.1:18090/api" {
		t.Fatalf("BEEFTV_OPS_URL = %q", got)
	}
	if got := value("BEEFTV_AGENT_HOST_TOKEN"); got != "host-token" {
		t.Fatalf("BEEFTV_AGENT_HOST_TOKEN = %q", got)
	}
	if got := value("BEEFTV_OWNER_TOKEN"); got != "owner-token" {
		t.Fatalf("BEEFTV_OWNER_TOKEN = %q", got)
	}
	if got := value("BEEFTV_AGENT_DATA_DIR"); got != dataDir {
		t.Fatalf("BEEFTV_AGENT_DATA_DIR = %q", got)
	}
}

// 应用关闭必须带走「本进程启动的」宿主子进程；这是确定性父子退出用例，
// 用一个真实的长驻子进程验证，而不是只看代码。
func TestStopProcessAgentHostReapsOwnChildOnShutdown(t *testing.T) {
	dataDir := t.TempDir()
	script := filepath.Join(dataDir, "fake-agent-host.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec sleep 120\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	// 另起一个与本进程无关的长驻进程：关闭钩子绝不能碰它。
	outsider := exec.Command("sleep", "120")
	if err := outsider.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = outsider.Process.Kill(); _, _ = outsider.Process.Wait() })
	outsiderAlive := func() bool { return outsider.Process.Signal(syscall.Signal(0)) == nil }

	supervisor := &agentHostSupervisor{}
	if err := supervisor.start(dataDir, agentHostConfig{Model: "test", HostCommand: script}); err != nil {
		t.Fatalf("启动测试宿主失败: %v", err)
	}
	childPid := supervisorPid(supervisor)
	if childPid == 0 {
		t.Fatal("未记录子进程 PID")
	}
	if !supervisor.running() {
		t.Fatal("子进程应处于运行状态")
	}

	// 直接把钩子挂到进程级单例上：关闭路径走的就是这一个实例。
	previous := processAgentHostSupervisor
	processAgentHostSupervisor = supervisor
	t.Cleanup(func() { processAgentHostSupervisor = previous })

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := StopProcessAgentHost(ctx); err != nil {
		t.Fatalf("关闭钩子应成功停止本进程启动的宿主: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(childPid, syscall.Signal(0)) != nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := syscall.Kill(childPid, syscall.Signal(0)); err == nil {
		t.Fatalf("宿主子进程 %d 在关闭后仍在运行", childPid)
	}
	if !outsiderAlive() {
		t.Fatal("关闭钩子不应影响不是它启动的进程")
	}
	// 再次调用必须是 no-op（未启动状态），不能报错。
	if err := StopProcessAgentHost(context.Background()); err != nil {
		t.Fatalf("无自有宿主时钩子应为 no-op，实际 %v", err)
	}
}
