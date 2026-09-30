package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

// agentHostConfig 记录当前使用的文本模型与宿主启动命令；由本机用户在设置里配置。
type agentHostConfig struct {
	Model       string   `json:"model"`
	HostCommand string   `json:"hostCommand"`
	HostArgs    []string `json:"hostArgs,omitempty"`
	UpdatedAt   string   `json:"updatedAt,omitempty"`
}

const agentHostConfigFile = "agent_config.json"

// Resolve the packaged runtime relative to the executable, independently of cwd or PATH.
func bundledAgentHostConfig() agentHostConfig {
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return agentHostConfig{}
	}
	return bundledAgentHostConfigFor(executable, runtime.GOOS)
}

// Both desktop layouts execute Node directly; Windows must not require a POSIX shell.
func bundledAgentHostConfigFor(executable, goos string) agentHostConfig {
	if strings.TrimSpace(executable) == "" {
		return agentHostConfig{}
	}
	root := filepath.Join(filepath.Dir(executable), "..", "Resources", "agent-host")
	node := filepath.Join(root, "runtime", "bin", "node")
	if goos == "windows" {
		root = filepath.Join(filepath.Dir(executable), "agent-host")
		node = filepath.Join(root, "runtime", "node.exe")
	}
	entry := filepath.Join(root, "server.mjs")
	for _, file := range []string{node, entry} {
		if info, err := os.Stat(file); err != nil || info.IsDir() {
			return agentHostConfig{}
		}
	}
	return agentHostConfig{HostCommand: node, HostArgs: []string{entry}}
}

// Explicit local configuration takes precedence over the packaged runtime.
func effectiveAgentHostConfig(dataDir string) (agentHostConfig, bool) {
	config, configured := readAgentHostConfig(dataDir)
	if strings.TrimSpace(config.HostCommand) == "" {
		if bundled := bundledAgentHostConfig(); bundled.HostCommand != "" {
			config.HostCommand = bundled.HostCommand
			config.HostArgs = bundled.HostArgs
			configured = true
		}
	}
	return config, configured
}

func readAgentHostConfig(dataDir string) (agentHostConfig, bool) {
	raw, err := os.ReadFile(filepath.Join(dataDir, agentHostConfigFile))
	if err != nil {
		return agentHostConfig{}, false
	}
	var config agentHostConfig
	if json.Unmarshal(raw, &config) != nil {
		return agentHostConfig{}, false
	}
	return config, true
}

func writeAgentHostConfig(dataDir string, config agentHostConfig) error {
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, ".agent-config-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dataDir, agentHostConfigFile))
}

// agentHostSupervisor 持有宿主子进程的 PID 以便停止与状态查询，
// 并记下启动时生效的供应商指纹：配置变了就需要在空闲时重启，否则宿主会一直用旧模型。
type agentHostSupervisor struct {
	mu          sync.Mutex
	cmd         *exec.Cmd
	done        chan struct{}
	fingerprint string
	launchedAt  time.Time
	lastErr     error
}

// hostState 是状态查询需要的宿主进程事实（不含任何凭据）。
type hostState struct {
	Running     bool
	Fingerprint string
	LaunchedAt  time.Time
	LastError   error
}

func (s *agentHostSupervisor) state() hostState {
	s.mu.Lock()
	defer s.mu.Unlock()
	running := s.cmd != nil && s.cmd.Process != nil
	if running {
		select {
		case <-s.done:
			running = false
		default:
		}
	}
	return hostState{Running: running, Fingerprint: s.fingerprint, LaunchedAt: s.launchedAt, LastError: s.lastErr}
}

// processAgentHostSupervisor 是进程内唯一实例：路由（启停/状态）与应用关闭钩子
// 必须操作同一个对象，否则关闭时找不到本进程启动过的宿主子进程。
var processAgentHostSupervisor = &agentHostSupervisor{}

// StopProcessAgentHost 在应用关闭时停止**本进程启动的**内置宿主子进程。
//
// 只对它自己启动过的进程生效（未启动时是 no-op），不会去清理外接宿主或别人的 PID；
// 宿主不可达/已退出时返回 nil，避免把关闭流程拖成失败。
func StopProcessAgentHost(ctx context.Context) error {
	supervisor := processAgentHostSupervisor
	if !supervisor.running() {
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- supervisor.stop() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("停止内置创作助手宿主：%w", err)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("停止内置创作助手宿主超时：%w", ctx.Err())
	}
}

func (s *agentHostSupervisor) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return false
	}
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

// assistantHostAPI 把渠道协议映射成 pi-ai 的 API 适配器名；宿主按它构造模型定义。
func assistantHostAPI(protocol string) string {
	switch protocol {
	case "claude-api":
		return "anthropic-messages"
	case "responses":
		return "openai-responses"
	default:
		return "openai-completions"
	}
}

// assistantHostBaseURL 按适配器约定整理接口地址：
// OpenAI 兼容 SDK 会在 baseURL 后直接拼 /chat/completions 或 /responses，所以要带 /v1；
// Anthropic SDK 自己拼 /v1/messages，所以要去掉 /v1。渠道配置里两种写法都可能出现。
func assistantHostBaseURL(baseURL, protocol string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return ""
	}
	hasV1 := strings.HasSuffix(trimmed, "/v1")
	if assistantHostAPI(protocol) == "anthropic-messages" {
		if hasV1 {
			return strings.TrimSuffix(trimmed, "/v1")
		}
		return trimmed
	}
	if hasV1 {
		return trimmed
	}
	return trimmed + "/v1"
}

// hostEnv 构造宿主子进程环境：凭据与数据目录由后端注入，宿主不从用户全局环境取。
func hostEnv(dataDir string, provider app.AssistantProvider, opsURL string, desktopToken string) []string {
	env := os.Environ()
	appendIf := func(key, value string) {
		if strings.TrimSpace(value) != "" {
			env = append(env, key+"="+value)
		}
	}
	appendIf("BEEFTV_AGENT_DATA_DIR", dataDir)
	appendIf("BEEFTV_AGENT_MODEL", provider.Model)
	appendIf("BEEFTV_AGENT_BASE_URL", assistantHostBaseURL(provider.BaseURL, provider.Protocol))
	// 协议随环境下发：宿主不再假设一切都是 OpenAI 兼容接口。
	appendIf("BEEFTV_AGENT_API", assistantHostAPI(provider.Protocol))
	// 宿主把 BEEFTV_OPS_URL 当基址再拼 /ops；少了 /api 前缀时操作层探测只会拿到 404，
	// 宿主随即退出（表现为「助手不可用」）。
	// 地址必须来自真实运行中的后端：桌面形态监听随机回环端口，凭环境变量猜端口会指向错误位置。
	appendIf("BEEFTV_OPS_URL", opsBaseURL(opsURL))
	appendIf("BEEFTV_AGENT_HOST_TOKEN", readAgentHostToken(dataDir))
	appendIf("BEEFTV_OWNER_TOKEN", ownerTokenFromFile(dataDir))
	// 桌面形态整个 API 由启动令牌把关：宿主是桌面壳的一部分，像页面一样出示同一个令牌，
	// 而不是让操作层为它开一条豁免路径。
	appendIf("BEEFTV_AGENT_DESKTOP_TOKEN", desktopToken)
	// 模型密钥来自应用已有配置（或显式注入），只在进程内传给子进程。
	appendIf("BEEFTV_AGENT_API_KEY", provider.APIKey)
	return env
}

// opsBaseURL 规范化操作层基址：显式传入的（真实监听地址/请求地址）优先，
// 没有时退回环境变量推导，保证既有部署方式不被打断。
func opsBaseURL(explicit string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(explicit), "/")
	if trimmed == "" {
		return "http://127.0.0.1:" + strconv.Itoa(backendPort()) + "/api"
	}
	if !strings.HasSuffix(trimmed, "/api") {
		trimmed += "/api"
	}
	return trimmed
}

func backendPort() int {
	if value := strings.TrimSpace(os.Getenv("CANVAS_BACKEND_ADDR")); value != "" {
		if idx := strings.LastIndex(value, ":"); idx >= 0 {
			if port, err := strconv.Atoi(value[idx+1:]); err == nil {
				return port
			}
		}
	}
	return 8080
}

// resolveAssistantProvider 按用户选中的渠道解析模型与凭据（app 层拥有规则），
// 并允许显式环境变量覆盖，便于开发与受控测试。
//
// 失败时返回的 reason 直接就是 /assistant/status 契约里的机器可读原因。
func resolveAssistantProvider(svc *app.Service) (app.AssistantProvider, string) {
	override := app.AssistantProvider{
		BaseURL:  strings.TrimSpace(os.Getenv("BEEFTV_AGENT_BASE_URL")),
		APIKey:   strings.TrimSpace(os.Getenv("BEEFTV_AGENT_API_KEY")),
		Model:    strings.TrimSpace(os.Getenv("BEEFTV_AGENT_MODEL")),
		Protocol: strings.TrimSpace(os.Getenv("BEEFTV_AGENT_PROTOCOL")),
	}
	if override.BaseURL != "" && override.APIKey != "" && override.Model != "" {
		if override.Protocol == "" {
			override.Protocol = "chat-completion"
		}
		override.ChannelID = "env"
		override.ChannelName = "环境变量"
		override.ModelKey = override.Model
		return override, ""
	}
	provider, err := svc.ResolveAssistantProvider()
	if err != nil {
		var unavailable *app.AssistantUnavailableError
		if errors.As(err, &unavailable) {
			return app.AssistantProvider{}, unavailable.Reason
		}
		return app.AssistantProvider{}, app.AssistantReasonModelNotConfigured
	}
	return provider, ""
}

// StartProcessAgentHost 在应用启动时按本机配置拉起内置宿主。
// 未配置启动命令或模型/凭据还没解析出来时是 no-op（用户没配好助手不应该让应用启动失败）；
// 之后界面查询 /assistant/status 会按当时的配置补上这次启动。
func StartProcessAgentHost(svc *app.Service, opsURL string, desktopToken string) error {
	config, configured := effectiveAgentHostConfig(svc.DataDir())
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return nil
	}
	provider, reason := resolveAssistantProvider(svc)
	if reason != "" {
		return nil
	}
	return processAgentHostSupervisor.start(svc.DataDir(), config, provider, opsURL, desktopToken)
}

func ownerTokenFromFile(dataDir string) string {
	raw, err := os.ReadFile(filepath.Join(dataDir, "agent_owner_token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func (s *agentHostSupervisor) start(dataDir string, config agentHostConfig, provider app.AssistantProvider, opsURL string, desktopToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		select {
		case <-s.done:
		default:
			return nil
		}
	}
	parts := strings.Fields(config.HostCommand)
	// Packaged paths (including Program Files) are executable names, never shell text.
	if config.HostArgs != nil {
		parts = append([]string{config.HostCommand}, config.HostArgs...)
	} else if info, err := os.Stat(config.HostCommand); err == nil && !info.IsDir() {
		parts = []string{config.HostCommand}
	}
	if len(parts) == 0 {
		return agentops.InvalidArg("empty_host_command", "未配置宿主启动命令")
	}
	// 模型只来自「用户选中的渠道模型」解析结果：本机 agent_config.json 里的 model
	// 只是历史字段，不能覆盖渠道解析（否则会把模型发往对不上的协议与地址）。
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Env = hostEnv(dataDir, provider, opsURL, desktopToken)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		s.lastErr = err
		return err
	}
	s.cmd = cmd
	s.done = make(chan struct{})
	s.fingerprint = provider.Fingerprint()
	s.launchedAt = time.Now()
	s.lastErr = nil
	done := s.done
	go func() { _ = cmd.Wait(); close(done) }()
	return nil
}

// Serialize stop/start and let the sole Wait goroutine confirm exit on every platform.
func (s *agentHostSupervisor) stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cmd := s.cmd
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
	} else {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
	done := s.done
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			return errors.New("宿主进程未在超时内退出")
		}
	}
	s.cmd = nil
	s.done = nil
	return nil
}

// RegisterAgentHostLifecycleRoutes 暴露宿主配置与启停：全部需要 owner 凭据 + 本机同源。
func RegisterAgentHostLifecycleRoutes(r gin.IRouter, svc *app.Service) {
	supervisor := processAgentHostSupervisor
	ownerGuard := func(c *gin.Context) bool { return requireOwner(c, svc) }

	r.GET("/assistant/host/config", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		config, configured := effectiveAgentHostConfig(svc.DataDir())
		provider, reason := resolveAssistantProvider(svc)
		// 只回可公开的模型信息，绝不回密钥。
		ok(c, gin.H{"config": config, "configured": configured, "supervisorRunning": supervisor.running(),
			"provider": gin.H{"model": provider.Model, "channelId": provider.ChannelID, "protocol": provider.Protocol,
				"baseUrl": provider.BaseURL, "hasKey": provider.APIKey != "", "reason": reason}})
	})

	r.PUT("/assistant/host/config", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		var request agentHostConfig
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体无效"))
			return
		}
		if err := writeAgentHostConfig(svc.DataDir(), request); err != nil {
			fail(c, http.StatusInternalServerError, app.BadAuthRequest("配置写入失败"))
			return
		}
		ok(c, gin.H{"config": request})
	})

	r.POST("/assistant/host/start", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		config, configured := effectiveAgentHostConfig(svc.DataDir())
		if !configured || strings.TrimSpace(config.HostCommand) == "" {
			// 命令只来自本机配置，绝不接受请求体传入的可执行命令。
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_command_missing",
				"msg": "未配置 agent-host 启动命令：请先在设置的创作助手中配置（发行形态下由产品启动链提供）"})
			return
		}
		// 请求本来就落在后端自己身上：用请求的 Host 推导操作层基址，避免猜端口；
		// 桌面形态下把请求自带的启动令牌转交给宿主。
		provider, reason := resolveAssistantProvider(svc)
		if reason != "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": reason,
				"msg": "助手模型或凭据还没准备好"})
			return
		}
		if err := supervisor.start(svc.DataDir(), config, provider, "http://"+c.Request.Host+"/api", strings.TrimSpace(c.GetHeader(httptransport.LaunchTokenHeader))); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_start_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"started": true, "pid": strconv.Itoa(supervisorPid(supervisor))})
	})

	r.POST("/assistant/host/stop", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		if err := supervisor.stop(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "reason": "host_stop_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"stopped": true})
	})
}

// ensureAgentHost 让状态查询自己把宿主带起来：
// 没跑就按当前配置启动；跑着但供应商指纹变了、而且此刻空闲，就重启到新配置。
// 返回 launched=true 表示这次调用刚拉起进程（界面此时应显示 host_starting）。
func ensureAgentHost(svc *app.Service, provider app.AssistantProvider, opsURL, desktopToken string, idle bool) (launched bool, err error) {
	supervisor := processAgentHostSupervisor
	config, configured := effectiveAgentHostConfig(svc.DataDir())
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return false, agentops.InvalidArg("host_command_missing", "未配置宿主启动命令")
	}
	state := supervisor.state()
	fingerprint := provider.Fingerprint()
	if state.Running {
		if state.Fingerprint == fingerprint || !idle {
			return false, nil
		}
		if stopErr := supervisor.stop(); stopErr != nil {
			return false, stopErr
		}
	}
	if startErr := supervisor.start(svc.DataDir(), config, provider, opsURL, desktopToken); startErr != nil {
		return false, startErr
	}
	return true, nil
}

// restartAgentHost 是「重试」按钮的真实动作：停掉旧进程再按当前配置启动。
func restartAgentHost(svc *app.Service, provider app.AssistantProvider, opsURL, desktopToken string) error {
	supervisor := processAgentHostSupervisor
	config, configured := effectiveAgentHostConfig(svc.DataDir())
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return agentops.InvalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if err := supervisor.stop(); err != nil {
		return err
	}
	return supervisor.start(svc.DataDir(), config, provider, opsURL, desktopToken)
}

func supervisorPid(s *agentHostSupervisor) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}
