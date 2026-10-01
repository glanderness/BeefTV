package assistantruntime

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
)

func testProvider() app.AssistantProvider {
	return app.AssistantProvider{Model: "gpt-5.5", BaseURL: "https://beefapi.com/v1", APIKey: "test-key", Protocol: "chat-completion"}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	got := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			got = strings.TrimPrefix(entry, prefix)
		}
	}
	return got
}

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

	env := New(Options{DataDir: dataDir}).buildEnv(testProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token")
	if got := envValue(env, "BEEFTV_OPS_URL"); got != "http://127.0.0.1:18090/api" {
		t.Fatalf("BEEFTV_OPS_URL 应使用显式地址，得到 %q", got)
	}
	if got := envValue(env, "BEEFTV_AGENT_HOST_TOKEN"); got != "host-token" {
		t.Fatalf("BEEFTV_AGENT_HOST_TOKEN = %q", got)
	}
	if got := envValue(env, "BEEFTV_OWNER_TOKEN"); got != "owner-token" {
		t.Fatalf("BEEFTV_OWNER_TOKEN = %q", got)
	}
	if got := envValue(env, "BEEFTV_AGENT_DATA_DIR"); got != dataDir {
		t.Fatalf("BEEFTV_AGENT_DATA_DIR = %q", got)
	}
	if got := envValue(env, "BEEFTV_AGENT_API_KEY"); got != "test-key" {
		t.Fatalf("BEEFTV_AGENT_API_KEY 应由调用方注入，得到 %q", got)
	}
	if got := envValue(env, "BEEFTV_AGENT_DESKTOP_TOKEN"); got != "desktop-shell-token" {
		t.Fatalf("桌面形态应把启动令牌交给宿主，得到 %q", got)
	}
}

// 显式注入的环境变量优先于渠道解析（开发与受控测试路径）；此时不需要应用服务。
func TestResolveAssistantProviderPrefersExplicitEnv(t *testing.T) {
	t.Setenv("BEEFTV_AGENT_API_KEY", "env-key")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://env.example/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "env-model")
	t.Setenv("BEEFTV_AGENT_PROTOCOL", "claude-api")

	provider, reason := ResolveProvider(nil)
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
	host := New(Options{DataDir: dataDir})
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
		env := host.buildEnv(app.AssistantProvider{Model: "m", BaseURL: item.baseURL, APIKey: "k", Protocol: item.protocol},
			"http://127.0.0.1:18090/api", "")
		if got := envValue(env, "BEEFTV_AGENT_API"); got != item.wantAPI {
			t.Fatalf("协议 %s 应映射到 %s，得到 %q", item.protocol, item.wantAPI, got)
		}
		if got := envValue(env, "BEEFTV_AGENT_BASE_URL"); got != item.wantBase {
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
func TestStartIsNoopWithoutConfig(t *testing.T) {
	host := New(Options{DataDir: t.TempDir()})
	if err := host.Start("http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("未配置宿主时应用启动不应失败: %v", err)
	}
	if host.Running() {
		t.Fatal("未配置时不应有宿主进程")
	}
}

// 打包布局：能从 Contents/MacOS/<exe> 推导出 Contents/Resources/agent-host，
// 不需要用户配置任何开发路径。
func TestBundledAgentHostCommandFollowsAppLayout(t *testing.T) {
	for _, goos := range []string{"darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Program Files", "BeefTV")
			executable := filepath.Join(root, "Contents", "MacOS", "BeefTV")
			hostDir := filepath.Join(root, "Contents", "Resources", "agent-host")
			node := filepath.Join(hostDir, "runtime", "bin", "node")
			if goos == "windows" {
				executable = filepath.Join(root, "BeefTV.exe")
				hostDir = filepath.Join(root, "agent-host")
				node = filepath.Join(hostDir, "runtime", "node.exe")
			}
			if err := os.MkdirAll(filepath.Dir(node), 0o755); err != nil {
				t.Fatal(err)
			}
			entry := filepath.Join(hostDir, "server.mjs")
			for _, file := range []string{node, entry} {
				if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			got := BundledConfig(executable, goos)
			if got.HostCommand != node || len(got.HostArgs) != 1 || got.HostArgs[0] != entry {
				t.Fatalf("invalid bundled command: %#v", got)
			}
			if err := os.Remove(node); err != nil {
				t.Fatal(err)
			}
			if got := BundledConfig(executable, goos); got.HostCommand != "" {
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
	script := filepath.Join(dir, fixtureExitName())
	if err := os.WriteFile(script, []byte(fixtureExitSource()), 0o755); err != nil {
		t.Fatal(err)
	}
	host := New(Options{DataDir: dir})
	if err := host.WriteConfig(HostConfig{HostCommand: script}); err != nil {
		t.Fatal(err)
	}
	provider := app.AssistantProvider{Model: "m", BaseURL: "https://example.invalid/v1", APIKey: "k", Protocol: "chat-completion"}
	for attempt := 0; attempt < 2; attempt++ {
		if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
			t.Fatal(err)
		}
		if !waitUntil(5*time.Second, func() bool { return !host.Running() }) {
			t.Fatal("exited child was not reaped")
		}
	}
	if err := host.Stop(); err != nil {
		t.Fatal(err)
	}
}

// 操作层基址必须来自真实运行中的后端：桌面形态监听随机回环端口，
// 用环境变量猜端口会把宿主的探测指向错误位置（表现为「助手不可用」）。
func TestOpsBaseURLPrefersExplicitAddress(t *testing.T) {
	if got := opsBaseURL("http://127.0.0.1:54321", "127.0.0.1:9999"); got != "http://127.0.0.1:54321/api" {
		t.Fatalf("显式地址应被采用并补 /api，得到 %q", got)
	}
	if got := opsBaseURL("http://127.0.0.1:54321/api", "127.0.0.1:9999"); got != "http://127.0.0.1:54321/api" {
		t.Fatalf("已带 /api 不应重复拼接，得到 %q", got)
	}
	if got := opsBaseURL("", "127.0.0.1:9999"); got != "http://127.0.0.1:9999/api" {
		t.Fatalf("无显式地址时应退回环境变量，得到 %q", got)
	}
}

func TestWriteConfigUsesRestrictedPermissions(t *testing.T) {
	dataDir := t.TempDir()
	host := New(Options{DataDir: dataDir})
	if err := host.WriteConfig(HostConfig{Model: "m", HostCommand: "/bin/true"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dataDir, hostConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			t.Fatalf("config permissions = %o, want 0600-class", perm)
		}
	}
	config, configured := host.EffectiveConfig()
	if !configured || config.HostCommand != "/bin/true" {
		t.Fatalf("effective config = %#v configured=%v", config, configured)
	}
}
