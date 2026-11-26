package assistantmcp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/localcrypto"
	"infinite-canvas/backend/internal/outbound"
)

const (
	configFileName     = "assistant-mcp-servers.json"
	maxServers         = 32
	defaultTimeoutSec  = 30
	minTimeoutSec      = 5
	maxTimeoutSec      = 300
	maxCommandBytes    = 512
	maxArgsCount       = 64
	maxArgBytes        = 2048
	maxCwdBytes        = 1024
	maxEnvEntries      = 64
	maxEnvValueBytes   = 8192
	maxHeaderEntries   = 32
	maxHeaderNameBytes = 128
	maxHeaderValBytes  = 4096
	maxHeaderTotal     = 16 << 10
)

var (
	serverNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	envKeyPattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	cgnatPrefix       = netip.MustParsePrefix("100.64.0.0/10")
	zeroNetPrefix     = netip.MustParsePrefix("0.0.0.0/8")
)

// ServerConfig is the full local configuration for one external MCP server
// consumed by BeefTV's built-in assistant via @earendil-works/pi-mcp.
type ServerConfig struct {
	Name       string            `json:"name"`
	Transport  string            `json:"transport"` // "stdio" or "http"
	Enabled    bool              `json:"enabled"`
	Command    string            `json:"command,omitempty"`
	Args       []string          `json:"args,omitempty"`
	Cwd        string            `json:"cwd,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	URL        string            `json:"url,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	TimeoutSec int               `json:"timeoutSec,omitempty"`
	CreatedAt  string            `json:"createdAt,omitempty"`
	UpdatedAt  string            `json:"updatedAt,omitempty"`
}

// ServerView is the UI-safe projection that never exposes secret env/header values.
type ServerView struct {
	Name       string   `json:"name"`
	Transport  string   `json:"transport"`
	Enabled    bool     `json:"enabled"`
	Command    string   `json:"command,omitempty"`
	Args       []string `json:"args,omitempty"`
	Cwd        string   `json:"cwd,omitempty"`
	URL        string   `json:"url,omitempty"`
	TimeoutSec int      `json:"timeoutSec"`
	EnvKeys    []string `json:"envKeys"`
	HeaderKeys []string `json:"headerKeys"`
	CreatedAt  string   `json:"createdAt,omitempty"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
}

// UpsertInput creates or updates an MCP server while letting callers preserve
// existing secret env/header values when editing non-secret fields.
type UpsertInput struct {
	Name          string            `json:"name"`
	Transport     string            `json:"transport"`
	Enabled       *bool             `json:"enabled,omitempty"`
	Command       *string           `json:"command,omitempty"`
	Args          *[]string         `json:"args,omitempty"`
	Cwd           *string           `json:"cwd,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	RemoveEnv     []string          `json:"removeEnv,omitempty"`
	URL           *string           `json:"url,omitempty"`
	Headers       map[string]string `json:"headers,omitempty"`
	RemoveHeaders []string          `json:"removeHeaders,omitempty"`
	TimeoutSec    *int              `json:"timeoutSec,omitempty"`
}

type storedDocument struct {
	Version int            `json:"version"`
	Servers []ServerConfig `json:"servers"`
}

// Store persists workspace-local external MCP server definitions with encrypted
// header/env values in <dataDir>/assistant-mcp-servers.json (0600).
type Store struct {
	dataDir string
	mu      sync.RWMutex
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: strings.TrimSpace(dataDir)}
}

func (s *Store) path() string {
	return filepath.Join(s.dataDir, configFileName)
}

// ListViews returns all configured MCP servers with secret values redacted.
func (s *Store) ListViews() ([]ServerView, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	servers, err := s.loadUnlocked(false)
	if err != nil {
		return nil, err
	}
	views := make([]ServerView, 0, len(servers))
	for _, srv := range servers {
		views = append(views, srv.View())
	}
	return views, nil
}

// ListEnabledRuntime returns all enabled MCP servers with decrypted env/headers
// for the local agent-host process, plus a stable fingerprint for change detection.
func (s *Store) ListEnabledRuntime() ([]ServerConfig, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	servers, err := s.loadUnlocked(true)
	if err != nil {
		return nil, "", err
	}
	enabled := make([]ServerConfig, 0, len(servers))
	for _, srv := range servers {
		if srv.Enabled {
			enabled = append(enabled, srv)
		}
	}
	return enabled, Fingerprint(enabled), nil
}

// GetRuntime returns one decrypted server configuration by name (enabled or disabled),
// used when explicitly testing a single saved server connection.
func (s *Store) GetRuntime(name string) (*ServerConfig, error) {
	cleanName := strings.TrimSpace(name)
	if !serverNamePattern.MatchString(cleanName) {
		return nil, kernel.BadAuthRequest("MCP 服务名称无效")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	servers, err := s.loadUnlocked(true)
	if err != nil {
		return nil, err
	}
	for i := range servers {
		if servers[i].Name == cleanName {
			cp := servers[i]
			return &cp, nil
		}
	}
	return nil, kernel.NotFound("未找到该 MCP 服务")
}

// Upsert validates and atomically persists a new or updated MCP server config.
func (s *Store) Upsert(input UpsertInput) (ServerView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	servers, err := s.loadUnlocked(true)
	if err != nil {
		return ServerView{}, err
	}
	name := strings.TrimSpace(input.Name)
	if !serverNamePattern.MatchString(name) {
		return ServerView{}, kernel.BadAuthRequest("MCP 服务名称只支持字母、数字、下划线和连字符，且需以字母或数字开头（最多 64 位）")
	}

	existingIdx := -1
	var prev ServerConfig
	for i := range servers {
		if servers[i].Name == name {
			existingIdx = i
			prev = servers[i]
			break
		}
	}
	if existingIdx < 0 && len(servers) >= maxServers {
		return ServerView{}, kernel.BadAuthRequest(fmt.Sprintf("最多可配置 %d 个外部 MCP 服务", maxServers))
	}

	now := time.Now().UTC().Format(time.RFC3339)
	next := prev
	next.Name = name
	if existingIdx < 0 {
		next.Enabled = true
		next.TimeoutSec = defaultTimeoutSec
		next.CreatedAt = now
	}
	next.UpdatedAt = now

	if strings.TrimSpace(input.Transport) != "" {
		next.Transport = strings.ToLower(strings.TrimSpace(input.Transport))
	}
	if next.Transport == "streamable-http" {
		next.Transport = "http"
	}
	if input.Enabled != nil {
		next.Enabled = *input.Enabled
	}
	if input.TimeoutSec != nil {
		next.TimeoutSec = *input.TimeoutSec
	}
	if next.TimeoutSec == 0 {
		next.TimeoutSec = defaultTimeoutSec
	}

	switch next.Transport {
	case "stdio":
		if input.Command != nil {
			next.Command = strings.TrimSpace(*input.Command)
		}
		if input.Args != nil {
			next.Args = append([]string(nil), (*input.Args)...)
		}
		if input.Cwd != nil {
			next.Cwd = strings.TrimSpace(*input.Cwd)
		}
		next.Env = mergeSecretMap(prev.Env, input.Env, input.RemoveEnv)
		// Clear HTTP fields when switching transport.
		next.URL = ""
		next.Headers = nil
	case "http":
		if input.URL != nil {
			next.URL = strings.TrimSpace(*input.URL)
		}
		next.Headers = mergeHeaderMap(prev.Headers, input.Headers, input.RemoveHeaders)
		// Clear stdio fields when switching transport.
		next.Command = ""
		next.Args = nil
		next.Cwd = ""
		next.Env = nil
	case "sse":
		return ServerView{}, kernel.BadAuthRequest("暂不支持旧版 SSE 协议，请改用 Streamable HTTP 地址或本地 stdio 桥接命令")
	default:
		return ServerView{}, kernel.BadAuthRequest("传输方式只支持 stdio（本地命令）或 http（Streamable HTTP）")
	}

	if err := ValidateServerConfig(&next); err != nil {
		return ServerView{}, err
	}

	if existingIdx >= 0 {
		servers[existingIdx] = next
	} else {
		servers = append(servers, next)
		sort.Slice(servers, func(i, j int) bool { return servers[i].Name < servers[j].Name })
	}
	if err := s.saveUnlocked(servers); err != nil {
		return ServerView{}, err
	}
	return next.View(), nil
}

// Delete removes an MCP server configuration by name.
func (s *Store) Delete(name string) error {
	cleanName := strings.TrimSpace(name)
	if !serverNamePattern.MatchString(cleanName) {
		return kernel.BadAuthRequest("MCP 服务名称无效")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	servers, err := s.loadUnlocked(true)
	if err != nil {
		return err
	}
	idx := -1
	for i := range servers {
		if servers[i].Name == cleanName {
			idx = i
			break
		}
	}
	if idx < 0 {
		return kernel.NotFound("未找到该 MCP 服务")
	}
	servers = append(servers[:idx], servers[idx+1:]...)
	return s.saveUnlocked(servers)
}

func (c ServerConfig) View() ServerView {
	timeout := c.TimeoutSec
	if timeout <= 0 {
		timeout = defaultTimeoutSec
	}
	return ServerView{
		Name:       c.Name,
		Transport:  c.Transport,
		Enabled:    c.Enabled,
		Command:    c.Command,
		Args:       c.Args,
		Cwd:        c.Cwd,
		URL:        c.URL,
		TimeoutSec: timeout,
		EnvKeys:    sortedKeys(c.Env),
		HeaderKeys: sortedKeys(c.Headers),
		CreatedAt:  c.CreatedAt,
		UpdatedAt:  c.UpdatedAt,
	}
}

// ValidateServerConfig validates syntax, limits, and static SSRF guardrails
// without performing live DNS lookups so offline config saves always succeed.
func ValidateServerConfig(cfg *ServerConfig) error {
	if cfg == nil {
		return kernel.BadAuthRequest("MCP 配置不能为空")
	}
	cfg.Name = strings.TrimSpace(cfg.Name)
	if !serverNamePattern.MatchString(cfg.Name) {
		return kernel.BadAuthRequest("MCP 服务名称只支持字母、数字、下划线和连字符，且需以字母或数字开头（最多 64 位）")
	}
	cfg.Transport = strings.ToLower(strings.TrimSpace(cfg.Transport))
	if cfg.Transport == "streamable-http" {
		cfg.Transport = "http"
	}
	if cfg.TimeoutSec == 0 {
		cfg.TimeoutSec = defaultTimeoutSec
	}
	if cfg.TimeoutSec < minTimeoutSec || cfg.TimeoutSec > maxTimeoutSec {
		return kernel.BadAuthRequest(fmt.Sprintf("超时时间需在 %d 到 %d 秒之间", minTimeoutSec, maxTimeoutSec))
	}

	switch cfg.Transport {
	case "stdio":
		cfg.Command = strings.TrimSpace(cfg.Command)
		if cfg.Command == "" {
			return kernel.BadAuthRequest("本地命令（command）不能为空")
		}
		if len(cfg.Command) > maxCommandBytes || strings.ContainsAny(cfg.Command, "\x00\r\n") {
			return kernel.BadAuthRequest("本地命令格式无效或过长")
		}
		if len(cfg.Args) > maxArgsCount {
			return kernel.BadAuthRequest(fmt.Sprintf("命令参数最多支持 %d 项", maxArgsCount))
		}
		for _, arg := range cfg.Args {
			if len(arg) > maxArgBytes || strings.ContainsRune(arg, '\x00') {
				return kernel.BadAuthRequest("命令参数格式无效或过长")
			}
		}
		cfg.Cwd = strings.TrimSpace(cfg.Cwd)
		if len(cfg.Cwd) > maxCwdBytes || strings.ContainsAny(cfg.Cwd, "\x00\r\n") {
			return kernel.BadAuthRequest("工作目录路径无效")
		}
		if len(cfg.Env) > maxEnvEntries {
			return kernel.BadAuthRequest(fmt.Sprintf("环境变量最多支持 %d 项", maxEnvEntries))
		}
		for k, v := range cfg.Env {
			if !envKeyPattern.MatchString(k) {
				return kernel.BadAuthRequest("环境变量名称无效：" + k)
			}
			if strings.HasPrefix(strings.ToUpper(k), "BEEFTV_AGENT_") {
				return kernel.BadAuthRequest("环境变量 " + k + " 由系统保留，不允许配置")
			}
			if len(v) > maxEnvValueBytes || strings.ContainsRune(v, '\x00') {
				return kernel.BadAuthRequest("环境变量值无效或过长：" + k)
			}
		}
		return nil

	case "http":
		if err := validateHTTPURL(cfg.URL); err != nil {
			return err
		}
		if err := validateHTTPHeaders(cfg.Headers); err != nil {
			return err
		}
		return nil

	default:
		return kernel.BadAuthRequest("传输方式只支持 stdio（本地命令）或 http（Streamable HTTP）")
	}
}

func validateHTTPURL(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 4096 {
		return kernel.BadAuthRequest("MCP 服务地址无效或过长")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" {
		return kernel.BadAuthRequest("请填写完整的 http:// 或 https:// MCP 地址")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return kernel.BadAuthRequest("MCP 地址只支持 http/https")
	}
	if parsed.User != nil {
		return kernel.BadAuthRequest("MCP 地址不允许内嵌账号密码，请改用自定义请求头")
	}
	if parsed.Fragment != "" {
		return kernel.BadAuthRequest("MCP 地址不允许包含 # 片段")
	}
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(parsed.Hostname())), ".")
	allowPrivate := allowPrivateMCPUpstreams() || outbound.AllowedPrivateUpstreamHost(host)
	if scheme == "http" && !allowPrivate {
		return kernel.BadAuthRequest("当前环境要求远程 MCP 使用 HTTPS（或配置可信私网白名单）")
	}
	if !allowPrivate && (host == "localhost" || strings.HasSuffix(host, ".localhost")) {
		return kernel.BadAuthRequest("当前环境禁止访问本机 MCP 地址")
	}
	if addr, parseErr := netip.ParseAddr(host); parseErr == nil {
		addr = addr.Unmap()
		if addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsUnspecified() || addr.IsMulticast() || zeroNetPrefix.Contains(addr) {
			return kernel.BadAuthRequest("不允许访问链路本地、未指定或组播地址")
		}
		if !allowPrivate && (addr.IsLoopback() || addr.IsPrivate() || cgnatPrefix.Contains(addr)) {
			return kernel.BadAuthRequest("当前环境禁止访问本机或内网 MCP 地址")
		}
	}
	return nil
}

func validateHTTPHeaders(headers map[string]string) error {
	if len(headers) > maxHeaderEntries {
		return kernel.BadAuthRequest(fmt.Sprintf("请求头最多支持 %d 项", maxHeaderEntries))
	}
	total := 0
	for k, v := range headers {
		name := strings.TrimSpace(k)
		if name == "" || len(name) > maxHeaderNameBytes || !validHeaderName(name) {
			return kernel.BadAuthRequest("请求头名称无效：" + k)
		}
		lower := strings.ToLower(name)
		if blockedMCPHeader(lower) {
			return kernel.BadAuthRequest("请求头 " + name + " 由系统管理，不允许自定义")
		}
		if len(v) > maxHeaderValBytes || !validHeaderValue(v) {
			return kernel.BadAuthRequest("请求头值仅支持标准 ASCII 可见字符：" + name)
		}
		total += len(name) + len(v)
		if total > maxHeaderTotal {
			return kernel.BadAuthRequest("请求头总大小不能超过 16KB")
		}
	}
	return nil
}

func blockedMCPHeader(lower string) bool {
	switch lower {
	case "host", "content-length", "transfer-encoding", "connection", "proxy-connection",
		"keep-alive", "te", "trailer", "upgrade", "proxy-authorization",
		"x-beeftv-agent-token", "x-desktop-token", "x-beeftv-owner", "x-beeftv-ui-session":
		return true
	}
	return strings.HasPrefix(lower, "x-canvas-") || strings.HasPrefix(lower, "x-beeftv-")
}

func validHeaderName(name string) bool {
	for i := 0; i < len(name); i++ {
		c := name[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("!#$%&'*+-.^_`|~", rune(c)) {
			continue
		}
		return false
	}
	return true
}

func validHeaderValue(value string) bool {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == '\t' || (c >= 32 && c <= 126) {
			continue
		}
		return false
	}
	return true
}

func allowPrivateMCPUpstreams() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS"))) {
	case "0", "false", "no":
		return false
	default:
		return true
	}
}

func Fingerprint(servers []ServerConfig) string {
	h := sha256.New()
	raw, _ := json.Marshal(servers)
	h.Write(raw)
	return hex.EncodeToString(h.Sum(nil))
}

func (s *Store) loadUnlocked(decryptSecrets bool) ([]ServerConfig, error) {
	if s.dataDir == "" {
		return []ServerConfig{}, nil
	}
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return []ServerConfig{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取 MCP 配置文件失败: %w", err)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return []ServerConfig{}, nil
	}
	var doc storedDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("MCP 配置文件已损坏: %w", err)
	}
	servers := doc.Servers
	if servers == nil {
		servers = []ServerConfig{}
	}
	if decryptSecrets {
		for i := range servers {
			if len(servers[i].Env) > 0 {
				decrypted := make(map[string]string, len(servers[i].Env))
				for k, v := range servers[i].Env {
					plain, decErr := s.decryptValue(v)
					if decErr != nil {
						return nil, fmt.Errorf("解密 MCP 服务 %s 环境变量失败: %w", servers[i].Name, decErr)
					}
					decrypted[k] = plain
				}
				servers[i].Env = decrypted
			}
			if len(servers[i].Headers) > 0 {
				decrypted := make(map[string]string, len(servers[i].Headers))
				for k, v := range servers[i].Headers {
					plain, decErr := s.decryptValue(v)
					if decErr != nil {
						return nil, fmt.Errorf("解密 MCP 服务 %s 请求头失败: %w", servers[i].Name, decErr)
					}
					decrypted[k] = plain
				}
				servers[i].Headers = decrypted
			}
		}
	}
	return servers, nil
}

func (s *Store) saveUnlocked(servers []ServerConfig) error {
	if s.dataDir == "" {
		return errors.New("缺少工作区数据目录")
	}
	if err := os.MkdirAll(s.dataDir, 0o700); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}
	encryptedServers := make([]ServerConfig, len(servers))
	for i, srv := range servers {
		cp := srv
		if len(srv.Env) > 0 {
			encEnv := make(map[string]string, len(srv.Env))
			for k, v := range srv.Env {
				enc, encErr := localcrypto.Encrypt(s.dataDir, v)
				if encErr != nil {
					return fmt.Errorf("加密 MCP 环境变量失败: %w", encErr)
				}
				encEnv[k] = enc
			}
			cp.Env = encEnv
		}
		if len(srv.Headers) > 0 {
			encHeaders := make(map[string]string, len(srv.Headers))
			for k, v := range srv.Headers {
				enc, encErr := localcrypto.Encrypt(s.dataDir, v)
				if encErr != nil {
					return fmt.Errorf("加密 MCP 请求头失败: %w", encErr)
				}
				encHeaders[k] = enc
			}
			cp.Headers = encHeaders
		}
		encryptedServers[i] = cp
	}
	payload, err := json.MarshalIndent(storedDocument{Version: 1, Servers: encryptedServers}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dataDir, ".assistant-mcp-servers-*")
	if err != nil {
		return fmt.Errorf("创建临时配置失败: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, s.path()); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("保存 MCP 配置失败: %w", err)
	}
	_ = os.Chmod(s.path(), 0o600)
	return nil
}

func (s *Store) decryptValue(raw string) (string, error) {
	if strings.HasPrefix(raw, localcrypto.Prefix) {
		return localcrypto.Decrypt(s.dataDir, raw)
	}
	return raw, nil
}

func mergeSecretMap(prev, updates map[string]string, removals []string) map[string]string {
	merged := make(map[string]string, len(prev)+len(updates))
	for k, v := range prev {
		merged[k] = v
	}
	for _, k := range removals {
		delete(merged, strings.TrimSpace(k))
	}
	for k, v := range updates {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		merged[key] = v
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

func mergeHeaderMap(prev, updates map[string]string, removals []string) map[string]string {
	merged := make(map[string]string, len(prev)+len(updates))
	for k, v := range prev {
		merged[http.CanonicalHeaderKey(strings.TrimSpace(k))] = v
	}
	for _, k := range removals {
		delete(merged, http.CanonicalHeaderKey(strings.TrimSpace(k)))
	}
	for k, v := range updates {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		merged[http.CanonicalHeaderKey(key)] = strings.TrimSpace(v)
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

func sortedKeys(m map[string]string) []string {
	if len(m) == 0 {
		return []string{}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
