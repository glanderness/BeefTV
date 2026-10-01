package assistantruntime

import (
	"os"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/assistant"
)

func (h *Host) buildEnv(provider assistant.Provider, opsURL, desktopToken string) []string {
	env := h.environ()
	appendIf := func(key, value string) {
		if strings.TrimSpace(value) != "" {
			env = append(env, key+"="+value)
		}
	}
	dataDir := h.dataDir()
	appendIf("BEEFTV_AGENT_DATA_DIR", dataDir)
	appendIf("BEEFTV_AGENT_MODEL", provider.Model)
	appendIf("BEEFTV_AGENT_BASE_URL", hostBaseURL(provider.BaseURL, provider.Protocol))
	// 协议随环境下发：宿主不再假设一切都是 OpenAI 兼容接口。
	appendIf("BEEFTV_AGENT_API", hostAPI(provider.Protocol))
	// 宿主把 BEEFTV_OPS_URL 当基址再拼 /ops；少了 /api 前缀时操作层探测只会拿到 404，
	// 宿主随即退出（表现为「助手不可用」）。
	// 地址必须来自真实运行中的后端：桌面形态监听随机回环端口，凭环境变量猜端口会指向错误位置。
	appendIf("BEEFTV_OPS_URL", opsBaseURL(opsURL, h.backendAddr()))
	appendIf("BEEFTV_AGENT_HOST_TOKEN", h.hostToken())
	appendIf("BEEFTV_OWNER_TOKEN", h.ownerToken())
	// 桌面形态整个 API 由启动令牌把关：宿主是桌面壳的一部分，像页面一样出示同一个令牌，
	// 而不是让操作层为它开一条豁免路径。
	appendIf("BEEFTV_AGENT_DESKTOP_TOKEN", desktopToken)
	// 模型密钥来自应用已有配置（或显式注入），只在进程内传给子进程。
	appendIf("BEEFTV_AGENT_API_KEY", provider.APIKey)
	return env
}

// hostAPI 把渠道协议映射成 pi-ai 的 API 适配器名；宿主按它构造模型定义。
func hostAPI(protocol string) string {
	switch protocol {
	case "claude-api":
		return "anthropic-messages"
	case "responses":
		return "openai-responses"
	default:
		return "openai-completions"
	}
}

// hostBaseURL 按适配器约定整理接口地址：
// OpenAI 兼容 SDK 会在 baseURL 后直接拼 /chat/completions 或 /responses，所以要带 /v1；
// Anthropic SDK 自己拼 /v1/messages，所以要去掉 /v1。渠道配置里两种写法都可能出现。
func hostBaseURL(baseURL, protocol string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return ""
	}
	hasV1 := strings.HasSuffix(trimmed, "/v1")
	if hostAPI(protocol) == "anthropic-messages" {
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

// opsBaseURL 规范化操作层基址：显式传入的（真实监听地址/请求地址）优先，
// 没有时退回环境变量推导，保证既有部署方式不被打断。
func opsBaseURL(explicit, backendAddr string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(explicit), "/")
	if trimmed == "" {
		return "http://127.0.0.1:" + strconv.Itoa(backendPort(backendAddr)) + "/api"
	}
	if !strings.HasSuffix(trimmed, "/api") {
		trimmed += "/api"
	}
	return trimmed
}

func backendPort(backendAddr string) int {
	if value := strings.TrimSpace(backendAddr); value != "" {
		if idx := strings.LastIndex(value, ":"); idx >= 0 {
			if port, err := strconv.Atoi(value[idx+1:]); err == nil {
				return port
			}
		}
	}
	return 8080
}

func (h *Host) environ() []string {
	if h != nil && h.opts.Environ != nil {
		return append([]string{}, h.opts.Environ()...)
	}
	return os.Environ()
}

func (h *Host) backendAddr() string {
	if h != nil && h.opts.BackendAddr != nil {
		return h.opts.BackendAddr()
	}
	return os.Getenv("CANVAS_BACKEND_ADDR")
}

func (h *Host) hostToken() string {
	if h != nil && h.opts.HostToken != nil {
		return strings.TrimSpace(h.opts.HostToken())
	}
	return ReadHostToken(h.dataDir())
}

func (h *Host) ownerToken() string {
	if h != nil && h.opts.OwnerToken != nil {
		return strings.TrimSpace(h.opts.OwnerToken())
	}
	return ReadOwnerToken(h.dataDir())
}
