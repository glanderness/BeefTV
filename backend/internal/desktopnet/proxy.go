package desktopnet

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
)

type systemProxySettings struct {
	config        httpproxy.Config
	excludeSimple bool
	autoConfig    bool
}

const systemProxyCacheTTL = 5 * time.Second

var (
	systemProxyMu     sync.Mutex
	systemProxyCached systemProxySettings
	systemProxyValid  bool
	systemProxyReadAt time.Time
	systemProxyReader = readSystemProxyRaw
	systemProxyNow    = time.Now
)

func invalidateSystemProxyCache() {
	systemProxyMu.Lock()
	systemProxyReadAt = time.Time{}
	systemProxyMu.Unlock()
}

// readSystemProxy reads OS static proxy settings with a short TTL cache so
// periodic status polls and chat requests do not spawn scutil on every call.
// Transient OS reader failures keep the last known good settings instead of
// flipping to empty and triggering spurious child restarts.
func readSystemProxy() systemProxySettings {
	systemProxyMu.Lock()
	now := systemProxyNow()
	if systemProxyValid && !systemProxyReadAt.IsZero() && now.Sub(systemProxyReadAt) < systemProxyCacheTTL {
		cached := systemProxyCached
		systemProxyMu.Unlock()
		return cached
	}
	reader := systemProxyReader
	prev := systemProxyCached
	hadPrev := systemProxyValid
	systemProxyMu.Unlock()

	settings, ok := reader()
	if !ok {
		if hadPrev {
			return prev
		}
		return systemProxySettings{}
	}
	systemProxyMu.Lock()
	systemProxyCached = settings
	systemProxyValid = true
	systemProxyReadAt = systemProxyNow()
	systemProxyMu.Unlock()
	return settings
}

// Status describes the effective proxy routing without exposing proxy addresses,
// bypass hosts or credentials.
type Status struct {
	Mode           string
	Preference     Mode
	AutoConfigOnly bool
}

// ConfigurationStatus returns no proxy addresses, bypass hosts or credentials.
func ConfigurationStatus() Status {
	preference := CurrentMode()
	status := Status{
		Mode:       "direct",
		Preference: preference,
	}
	if preference == ModeDirect {
		return status
	}
	if ExplicitProxyConfigured() {
		status.Mode = "environment"
		return status
	}
	system := readSystemProxy()
	if system.config.HTTPProxy != "" || system.config.HTTPSProxy != "" {
		status.Mode = "system"
	} else {
		status.AutoConfigOnly = system.autoConfig
	}
	return status
}

// Desktop launchers do not inherit shell proxy variables. Read system settings
// on each request so retry also works after the user changes their proxy.
func Proxy(req *http.Request) (*url.URL, error) {
	if CurrentMode() == ModeDirect {
		return nil, nil
	}
	config := environmentProxyConfig()
	if ExplicitProxyConfigured() {
		return config.ProxyFunc()(req.URL)
	}
	return proxyWithSystem(req.URL, *config, readSystemProxy())
}

// A local/private proxy is trusted as a user-selected egress, never as a
// target URL exemption. Outbound callers must still validate target addresses.
func ConfiguredProxyAddress(address string) bool {
	if CurrentMode() == ModeDirect {
		return false
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	config := *environmentProxyConfig()
	if !ExplicitProxyConfigured() {
		config = readSystemProxy().config
	}
	for _, raw := range []string{config.HTTPProxy, config.HTTPSProxy} {
		if raw == "" {
			continue
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		proxyPort := u.Port()
		if proxyPort == "" {
			switch u.Scheme {
			case "https":
				proxyPort = "443"
			case "socks5", "socks5h":
				proxyPort = "1080"
			default:
				proxyPort = "80"
			}
		}
		if port == proxyPort && strings.EqualFold(strings.Trim(u.Hostname(), "[]."), strings.Trim(host, "[].")) {
			return true
		}
	}
	return false
}

// HTTPSProxyEnvironment carries desktop proxy selection to HTTPS-only child
// downloaders, including redirect hosts and the system bypass list.
func HTTPSProxyEnvironment() []string {
	if CurrentMode() == ModeDirect {
		return []string{"HTTPS_PROXY=", "https_proxy=", "NO_PROXY=*", "no_proxy=*", "ALL_PROXY=", "all_proxy="}
	}
	config := environmentProxyConfig()
	if !ExplicitProxyConfigured() {
		system := readSystemProxy()
		config.HTTPSProxy = system.config.HTTPSProxy
		config.NoProxy = strings.Trim(config.NoProxy+","+system.config.NoProxy, ",")
	}
	bypass := strings.Split(config.NoProxy, ",")
	for i, host := range bypass {
		bypass[i] = strings.TrimSpace(host)
		if strings.HasPrefix(bypass[i], "*.") {
			bypass[i] = bypass[i][1:]
		}
	}
	noProxy := strings.Join(bypass, ",")
	return []string{"HTTPS_PROXY=" + config.HTTPSProxy, "https_proxy=" + config.HTTPSProxy, "NO_PROXY=" + noProxy, "no_proxy=" + noProxy, "ALL_PROXY=", "all_proxy="}
}

// golang.org/x/net v0.58.0+ flipped httpproxy.FromEnvironment to prefer
// lowercase environment variables (golang/go#79656). Keep desktopnet's
// uppercase-first precedence consistent with NodeProxyEnvironment and
// child downloader tests.
func environmentProxyConfig() *httpproxy.Config {
	return &httpproxy.Config{
		HTTPProxy:  firstNonEmptyEnv("HTTP_PROXY", "http_proxy"),
		HTTPSProxy: firstNonEmptyEnv("HTTPS_PROXY", "https_proxy"),
		NoProxy:    firstNonEmptyEnv("NO_PROXY", "no_proxy"),
		CGI:        os.Getenv("REQUEST_METHOD") != "",
	}
}

func firstNonEmptyEnv(names ...string) string {
	for _, name := range names {
		if v := os.Getenv(name); v != "" {
			return v
		}
	}
	return ""
}

// Explicit environment configuration must never be bypassed automatically
// unless the user explicitly selected direct mode in BeefTV settings.
func ExplicitProxyConfigured() bool {
	if CurrentMode() == ModeDirect {
		return false
	}
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return true
		}
	}
	return false
}

func proxyWithSystem(target *url.URL, env httpproxy.Config, system systemProxySettings) (*url.URL, error) {
	if system.excludeSimple && !strings.Contains(target.Hostname(), ".") && net.ParseIP(target.Hostname()) == nil {
		return nil, nil
	}
	env.HTTPProxy = system.config.HTTPProxy
	env.HTTPSProxy = system.config.HTTPSProxy
	env.NoProxy = strings.Trim(env.NoProxy+","+system.config.NoProxy, ",")
	return env.ProxyFunc()(target)
}

func parseWindowsProxy(server, bypass string) systemProxySettings {
	settings := systemProxySettings{excludeSimple: strings.Contains(strings.ToLower(bypass), "<local>")}
	settings.config.NoProxy = strings.ReplaceAll(strings.ReplaceAll(bypass, "<local>", ""), ";", ",")
	if !strings.Contains(server, "=") {
		settings.config.HTTPProxy = strings.TrimSpace(server)
		settings.config.HTTPSProxy = strings.TrimSpace(server)
		return settings
	}
	for _, part := range strings.Split(server, ";") {
		protocol, address, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch strings.ToLower(protocol) {
		case "http":
			settings.config.HTTPProxy = strings.TrimSpace(address)
		case "https":
			settings.config.HTTPSProxy = strings.TrimSpace(address)
		}
	}
	return settings
}

func parseMacProxy(output string) systemProxySettings {
	values := map[string]string{}
	var bypass []string
	inExceptions := false
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ExceptionsList :") {
			inExceptions = true
			continue
		}
		if line == "}" {
			inExceptions = false
			continue
		}
		key, value, ok := strings.Cut(line, " : ")
		if !ok {
			continue
		}
		if inExceptions {
			bypass = append(bypass, value)
		} else {
			values[key] = value
		}
	}
	address := func(protocol string) string {
		if values[protocol+"Enable"] != "1" {
			return ""
		}
		host, port := values[protocol+"Proxy"], values[protocol+"Port"]
		n, err := strconv.Atoi(port)
		if host == "" || err != nil || n < 1 || n > 65535 {
			return ""
		}
		return "http://" + net.JoinHostPort(host, port)
	}
	return systemProxySettings{
		config:        httpproxy.Config{HTTPProxy: address("HTTP"), HTTPSProxy: address("HTTPS"), NoProxy: strings.Join(bypass, ",")},
		excludeSimple: values["ExcludeSimpleHostnames"] == "1",
		autoConfig:    values["ProxyAutoConfigEnable"] == "1" || values["ProxyAutoDiscoveryEnable"] == "1",
	}
}
