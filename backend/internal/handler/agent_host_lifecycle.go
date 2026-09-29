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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	httptransport "infinite-canvas/backend/internal/transport/http"
	"infinite-canvas/backend/internal/workspace"
)

// agentHostConfig 记录当前使用的文本模型与宿主启动命令；由本机用户在设置里配置。
type agentHostConfig struct {
	Model       string `json:"model"`
	HostCommand string `json:"hostCommand"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

const agentHostConfigFile = "agent_config.json"

// bundledAgentHostCommand 返回应用包内自带的宿主启动脚本路径。
//
// 发行形态把 agent-host 与（可选的）Node 运行时放在 BeefTV.app/Contents/Resources/agent-host/，
// 二进制位于 Contents/MacOS/，因此相对可执行文件推导 Resources，不依赖调用方 cwd。
func bundledAgentHostCommand() string {
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return ""
	}
	return bundledAgentHostCommandFor(executable)
}

// bundledAgentHostCommandFor 从可执行文件位置推导包内启动脚本；独立出来便于对打包布局做确定性测试。
func bundledAgentHostCommandFor(executable string) string {
	if strings.TrimSpace(executable) == "" {
		return ""
	}
	launcher := filepath.Join(filepath.Dir(executable), "..", "Resources", "agent-host", "run-agent-host.sh")
	if info, statErr := os.Stat(launcher); statErr != nil || info.IsDir() {
		return ""
	}
	return launcher
}

// effectiveAgentHostConfig 合并「本机配置」与「应用自带启动脚本」：
// 用户配置优先；没有配置时用包内脚本，让发行形态开箱即可用。
func effectiveAgentHostConfig(dataDir string) (agentHostConfig, bool) {
	config, configured := readAgentHostConfig(dataDir)
	if strings.TrimSpace(config.HostCommand) == "" {
		if bundled := bundledAgentHostCommand(); bundled != "" {
			config.HostCommand = bundled
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

// agentHostSupervisor 只在被显式要求时启动宿主，并持有其 PID 以便停止与状态查询。
type agentHostSupervisor struct {
	mu  sync.Mutex
	cmd *exec.Cmd
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
	return s.cmd.Process.Signal(syscall.Signal(0)) == nil
}

// hostEnv 构造宿主子进程环境：凭据与数据目录由后端注入，宿主不从用户全局环境取。
func hostEnv(dataDir, model, baseURL string, apiKey string, opsURL string, desktopToken string) []string {
	env := os.Environ()
	appendIf := func(key, value string) {
		if strings.TrimSpace(value) != "" {
			env = append(env, key+"="+value)
		}
	}
	appendIf("BEEFTV_AGENT_DATA_DIR", dataDir)
	appendIf("BEEFTV_AGENT_MODEL", model)
	appendIf("BEEFTV_AGENT_BASE_URL", baseURL)
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
	appendIf("BEEFTV_AGENT_API_KEY", apiKey)
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

// assistantProvider 是内置助手要用的文本模型连接信息。
type assistantProvider struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

// resolveAssistantProvider 复用应用已有的本地模型配置（local-model-config.json），
// 而不是要求一个只存在于进程环境里的临时密钥。显式注入的环境变量仍然优先，
// 便于开发与受控测试；两者都没有时返回空值，宿主会以「未就绪」呈现。
func resolveAssistantProvider(dataDir string) assistantProvider {
	provider := assistantProvider{
		BaseURL: strings.TrimSpace(os.Getenv("BEEFTV_AGENT_BASE_URL")),
		APIKey:  strings.TrimSpace(os.Getenv("BEEFTV_AGENT_API_KEY")),
		Model:   strings.TrimSpace(os.Getenv("BEEFTV_AGENT_MODEL")),
	}
	config, err := workspace.NewProviderConfig(dataDir)
	if err != nil {
		return provider
	}
	raw, err := config.ReadLocalModelConfig()
	if err != nil || len(raw) == 0 {
		return provider
	}
	// ReadLocalModelConfig 返回的是已合并的内层 config 对象（不含 schemaVersion/revision 包装），
	// 这里同时兼容带 config 包装的形状，避免读取面变化时静默退回空值。
	var envelope struct {
		APIKey    string `json:"apiKey"`
		BaseURL   string `json:"baseUrl"`
		TextModel string `json:"textModel"`
		Model     string `json:"model"`
		Config    *struct {
			APIKey    string `json:"apiKey"`
			BaseURL   string `json:"baseUrl"`
			TextModel string `json:"textModel"`
			Model     string `json:"model"`
		} `json:"config"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return provider
	}
	if envelope.Config != nil {
		if envelope.APIKey == "" {
			envelope.APIKey = envelope.Config.APIKey
		}
		if envelope.BaseURL == "" {
			envelope.BaseURL = envelope.Config.BaseURL
		}
		if envelope.TextModel == "" {
			envelope.TextModel = envelope.Config.TextModel
		}
		if envelope.Model == "" {
			envelope.Model = envelope.Config.Model
		}
	}
	if provider.BaseURL == "" {
		provider.BaseURL = strings.TrimSpace(envelope.BaseURL)
	}
	if provider.APIKey == "" {
		provider.APIKey = strings.TrimSpace(envelope.APIKey)
	}
	if provider.Model == "" {
		provider.Model = strings.TrimSpace(envelope.TextModel)
		if provider.Model == "" {
			provider.Model = strings.TrimSpace(envelope.Model)
		}
	}
	return provider
}

// StartProcessAgentHost 在应用启动时按本机配置拉起内置宿主。
// 未配置启动命令时是 no-op（用户没有开启助手不应该让应用启动失败）。
func StartProcessAgentHost(dataDir string, opsURL string, desktopToken string) error {
	config, configured := effectiveAgentHostConfig(dataDir)
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return nil
	}
	return processAgentHostSupervisor.start(dataDir, config, opsURL, desktopToken)
}

func ownerTokenFromFile(dataDir string) string {
	raw, err := os.ReadFile(filepath.Join(dataDir, "agent_owner_token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func (s *agentHostSupervisor) start(dataDir string, config agentHostConfig, opsURL string, desktopToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil && s.cmd.Process.Signal(syscall.Signal(0)) == nil {
		return nil
	}
	parts := strings.Fields(config.HostCommand)
	if len(parts) == 0 {
		return agentops.InvalidArg("empty_host_command", "未配置宿主启动命令")
	}
	provider := resolveAssistantProvider(dataDir)
	model := strings.TrimSpace(config.Model)
	if model == "" {
		model = provider.Model
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Env = hostEnv(dataDir, model, provider.BaseURL, provider.APIKey, opsURL, desktopToken)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	s.cmd = cmd
	return nil
}

// stop 发送 SIGTERM 并等待真实退出；未在超时内退出则试 SIGKILL，仍失败则如实报错。
func (s *agentHostSupervisor) stop() error {
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Signal(syscall.SIGKILL)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			return errors.New("宿主进程未在超时内退出")
		}
	}
	s.mu.Lock()
	s.cmd = nil
	s.mu.Unlock()
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
		provider := resolveAssistantProvider(svc.DataDir())
		// 只回可公开的模型信息，绝不回密钥。
		ok(c, gin.H{"config": config, "configured": configured, "supervisorRunning": supervisor.running(),
			"provider": gin.H{"model": provider.Model, "baseUrl": provider.BaseURL, "hasKey": provider.APIKey != ""}})
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
		if err := supervisor.start(svc.DataDir(), config, "http://"+c.Request.Host+"/api", strings.TrimSpace(c.GetHeader(httptransport.LaunchTokenHeader))); err != nil {
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

func supervisorPid(s *agentHostSupervisor) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}
