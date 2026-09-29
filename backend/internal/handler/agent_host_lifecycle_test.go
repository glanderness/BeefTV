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

	env := hostEnv(dataDir, "gpt-5.5", "https://beefapi.com/v1", "test-key", "http://127.0.0.1:18090/api", "desktop-shell-token")
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
		t.Fatalf("BEEFTV_OPS_URL 应使用显式地址，得到 %q", got)
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
	if got := value("BEEFTV_AGENT_API_KEY"); got != "test-key" {
		t.Fatalf("BEEFTV_AGENT_API_KEY 应由调用方注入，得到 %q", got)
	}
	if got := value("BEEFTV_AGENT_DESKTOP_TOKEN"); got != "desktop-shell-token" {
		t.Fatalf("桌面形态应把启动令牌交给宿主，得到 %q", got)
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
	if err := supervisor.start(dataDir, agentHostConfig{Model: "test", HostCommand: script}, "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
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

// 内置助手的模型连接信息复用应用已有的本地模型配置，不再要求一个只存在于进程环境里的密钥。
func TestResolveAssistantProviderUsesLocalModelConfig(t *testing.T) {
	dataDir := t.TempDir()
	config := `{"schemaVersion":1,"revision":1,"config":{"apiKey":"local-config-key","baseUrl":"https://beefapi.com/v1","textModel":"gpt-5.5","model":"fallback-model"}}`
	if err := os.WriteFile(filepath.Join(dataDir, "local-model-config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"BEEFTV_AGENT_API_KEY", "BEEFTV_AGENT_BASE_URL", "BEEFTV_AGENT_MODEL"} {
		t.Setenv(key, "")
	}

	provider := resolveAssistantProvider(dataDir)

	if provider.APIKey != "local-config-key" || provider.BaseURL != "https://beefapi.com/v1" || provider.Model != "gpt-5.5" {
		t.Fatalf("应从本地模型配置解析出三元组，得到 %#v", provider)
	}
}

// 显式注入的环境变量优先于本地配置（开发与受控测试路径）。
func TestResolveAssistantProviderPrefersExplicitEnv(t *testing.T) {
	dataDir := t.TempDir()
	config := `{"config":{"apiKey":"local-config-key","baseUrl":"https://local.example/v1","textModel":"local-model"}}`
	if err := os.WriteFile(filepath.Join(dataDir, "local-model-config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_AGENT_API_KEY", "env-key")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://env.example/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "env-model")

	provider := resolveAssistantProvider(dataDir)

	if provider.APIKey != "env-key" || provider.BaseURL != "https://env.example/v1" || provider.Model != "env-model" {
		t.Fatalf("显式注入应优先，得到 %#v", provider)
	}
}

// 未配置启动命令时，启动链上的自动拉起必须是 no-op，不能让应用启动失败。
func TestStartProcessAgentHostIsNoopWithoutConfig(t *testing.T) {
	previous := processAgentHostSupervisor
	processAgentHostSupervisor = &agentHostSupervisor{}
	t.Cleanup(func() { processAgentHostSupervisor = previous })

	if err := StartProcessAgentHost(t.TempDir(), "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("未配置宿主时应用启动不应失败: %v", err)
	}
	if processAgentHostSupervisor.running() {
		t.Fatal("未配置时不应有宿主进程")
	}
}

// 打包布局：能从 Contents/MacOS/<exe> 推导出 Contents/Resources/agent-host/run-agent-host.sh，
// 不需要用户配置任何开发路径。
func TestBundledAgentHostCommandFollowsAppLayout(t *testing.T) {
	for _, goos := range []string{"darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Program Files", "BeefTV")
			executable := filepath.Join(root, "Contents", "MacOS", "BeefTV")
			host := filepath.Join(root, "Contents", "Resources", "agent-host")
			node := filepath.Join(host, "runtime", "bin", "node")
			if goos == "windows" {
				executable = filepath.Join(root, "BeefTV.exe")
				host = filepath.Join(root, "agent-host")
				node = filepath.Join(host, "runtime", "node.exe")
			}
			if err := os.MkdirAll(filepath.Dir(node), 0o755); err != nil {
				t.Fatal(err)
			}
			entry := filepath.Join(host, "server.mjs")
			for _, file := range []string{node, entry} {
				if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			got := bundledAgentHostConfigFor(executable, goos)
			if got.HostCommand != node || len(got.HostArgs) != 1 || got.HostArgs[0] != entry {
				t.Fatalf("invalid bundled command: %#v", got)
			}
			if err := os.Remove(node); err != nil {
				t.Fatal(err)
			}
			if got := bundledAgentHostConfigFor(executable, goos); got.HostCommand != "" {
				t.Fatalf("missing runtime must not fall back to PATH: %#v", got)
			}
		})
	}
}

func TestAgentHostReapsExitAndRestartsWithSpacedPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "directory with spaces")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "host.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &agentHostSupervisor{}
	for attempt := 0; attempt < 2; attempt++ {
		if err := s.start(dir, agentHostConfig{HostCommand: script}, "http://127.0.0.1:18090/api", ""); err != nil {
			t.Fatal(err)
		}
		select {
		case <-s.done:
		case <-time.After(5 * time.Second):
			t.Fatal("exited child was not reaped")
		}
		if s.running() {
			t.Fatal("exited child reported running")
		}
	}
	if err := s.stop(); err != nil {
		t.Fatal(err)
	}
}

// 操作层基址必须来自真实运行中的后端：桌面形态监听随机回环端口，
// 用环境变量猜端口会把宿主的探测指向错误位置（表现为「助手不可用」）。
func TestOpsBaseURLPrefersExplicitAddress(t *testing.T) {
	t.Setenv("CANVAS_BACKEND_ADDR", "127.0.0.1:9999")

	if got := opsBaseURL("http://127.0.0.1:54321"); got != "http://127.0.0.1:54321/api" {
		t.Fatalf("显式地址应被采用并补 /api，得到 %q", got)
	}
	if got := opsBaseURL("http://127.0.0.1:54321/api"); got != "http://127.0.0.1:54321/api" {
		t.Fatalf("已带 /api 不应重复拼接，得到 %q", got)
	}
	// 没有显式地址时才退回环境变量推导，既有部署方式不受影响。
	if got := opsBaseURL(""); got != "http://127.0.0.1:9999/api" {
		t.Fatalf("无显式地址时应退回环境变量，得到 %q", got)
	}
}
