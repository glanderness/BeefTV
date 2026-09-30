package handler

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"infinite-canvas/backend/internal/app"
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

	env := hostEnv(dataDir, app.AssistantProvider{Model: "gpt-5.5", BaseURL: "https://beefapi.com/v1",
		APIKey: "test-key", Protocol: "chat-completion"}, "http://127.0.0.1:18090/api", "desktop-shell-token")
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
	if err := supervisor.start(dataDir, agentHostConfig{HostCommand: script}, app.AssistantProvider{Model: "test", BaseURL: "https://example.invalid/v1", APIKey: "test-key", Protocol: "chat-completion"}, "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
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

// 显式注入的环境变量优先于渠道解析（开发与受控测试路径）；此时不需要应用服务。
func TestResolveAssistantProviderPrefersExplicitEnv(t *testing.T) {
	t.Setenv("BEEFTV_AGENT_API_KEY", "env-key")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://env.example/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "env-model")
	t.Setenv("BEEFTV_AGENT_PROTOCOL", "claude-api")

	provider, reason := resolveAssistantProvider(nil)

	if reason != "" {
		t.Fatalf("显式注入时不应给出不可用原因，得到 %q", reason)
	}
	if provider.APIKey != "env-key" || provider.BaseURL != "https://env.example/v1" || provider.Model != "env-model" || provider.Protocol != "claude-api" {
		t.Fatalf("显式注入应优先，得到 %#v", provider)
	}
}

// 协议决定宿主使用哪个 pi-ai 适配器，也决定接口地址要不要带 /v1：
// OpenAI 兼容 SDK 在 baseURL 后直接拼路径，Anthropic SDK 自己拼 /v1/messages。
func TestAssistantHostEnvCarriesProtocolAndBaseURLShape(t *testing.T) {
	dataDir := t.TempDir()
	value := func(env []string, key string) string {
		prefix := key + "="
		got := ""
		for _, entry := range env {
			if strings.HasPrefix(entry, prefix) {
				got = strings.TrimPrefix(entry, prefix)
			}
		}
		return got
	}
	cases := []struct {
		protocol string
		baseURL  string
		wantAPI  string
		wantBase string
	}{
		{"chat-completion", "https://enterprise.beefapi.com", "openai-completions", "https://enterprise.beefapi.com/v1"},
		{"chat-completion", "https://enterprise.beefapi.com/v1/", "openai-completions", "https://enterprise.beefapi.com/v1"},
		{"responses", "https://enterprise.beefapi.com", "openai-responses", "https://enterprise.beefapi.com/v1"},
		{"claude-api", "https://enterprise.beefapi.com/v1", "anthropic-messages", "https://enterprise.beefapi.com"},
		{"claude-api", "https://enterprise.beefapi.com", "anthropic-messages", "https://enterprise.beefapi.com"},
	}
	for _, item := range cases {
		env := hostEnv(dataDir, app.AssistantProvider{Model: "m", BaseURL: item.baseURL, APIKey: "k", Protocol: item.protocol},
			"http://127.0.0.1:18090/api", "")
		if got := value(env, "BEEFTV_AGENT_API"); got != item.wantAPI {
			t.Fatalf("协议 %s 应映射到 %s，得到 %q", item.protocol, item.wantAPI, got)
		}
		if got := value(env, "BEEFTV_AGENT_BASE_URL"); got != item.wantBase {
			t.Fatalf("协议 %s 的接口地址应为 %s，得到 %q", item.protocol, item.wantBase, got)
		}
	}
}

// 供应商指纹必须随渠道/模型/地址/协议/密钥变化，否则配置换了也不会重启宿主。
func TestAssistantProviderFingerprintTracksEveryField(t *testing.T) {
	base := app.AssistantProvider{ChannelID: "beefapi", Model: "MiniMax-M3",
		BaseURL: "https://enterprise.beefapi.com/v1", Protocol: "chat-completion", APIKey: "one"}
	variants := []app.AssistantProvider{
		{ChannelID: "other", Model: base.Model, BaseURL: base.BaseURL, Protocol: base.Protocol, APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: "claude-fable-5", BaseURL: base.BaseURL, Protocol: base.Protocol, APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: base.Model, BaseURL: "https://other.example/v1", Protocol: base.Protocol, APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: base.Model, BaseURL: base.BaseURL, Protocol: "claude-api", APIKey: base.APIKey},
		{ChannelID: base.ChannelID, Model: base.Model, BaseURL: base.BaseURL, Protocol: base.Protocol, APIKey: "two"},
	}
	for _, variant := range variants {
		if variant.Fingerprint() == base.Fingerprint() {
			t.Fatalf("指纹未随字段变化: %#v", variant)
		}
	}
	if base.Fingerprint() != (app.AssistantProvider{ChannelID: "beefapi", Model: "MiniMax-M3",
		BaseURL: "https://enterprise.beefapi.com/v1", Protocol: "chat-completion", APIKey: "one"}).Fingerprint() {
		t.Fatal("相同配置应得到相同指纹")
	}
}

// 未配置启动命令时，启动链上的自动拉起必须是 no-op，不能让应用启动失败。
func TestStartProcessAgentHostIsNoopWithoutConfig(t *testing.T) {
	previous := processAgentHostSupervisor
	processAgentHostSupervisor = &agentHostSupervisor{}
	t.Cleanup(func() { processAgentHostSupervisor = previous })

	if err := StartProcessAgentHost(app.NewLocal(nil, t.TempDir()), "http://127.0.0.1:18090/api", ""); err != nil {
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
		if err := s.start(dir, agentHostConfig{HostCommand: script}, app.AssistantProvider{Model: "m", BaseURL: "https://example.invalid/v1", APIKey: "k", Protocol: "chat-completion"}, "http://127.0.0.1:18090/api", ""); err != nil {
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
