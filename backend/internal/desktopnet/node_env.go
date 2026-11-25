package desktopnet

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"runtime"
	"strings"

	"golang.org/x/net/http/httpproxy"
)

// NodeProxyEnvironment enables Node's public environment proxy support for a
// fixed model origin. System parsing and target selection stay with desktopnet.
// Return a replacement environment: duplicate/case-conflicting inherited keys
// otherwise have different precedence in Go, Node and Windows launchers.
func NodeProxyEnvironment(inherited []string, modelBaseURL string) []string {
	return nodeProxyEnvironmentWithMode(inherited, modelBaseURL, CurrentMode(), readSystemProxy)
}

// NodeProxyFingerprint returns a stable hash of the resolved Node proxy
// environment so supervisors can detect system proxy toggles or app mode
// changes without leaking proxy URLs or credentials.
func NodeProxyFingerprint(inherited []string, modelBaseURL string) string {
	return NodeProxyFingerprintFromEnv(NodeProxyEnvironment(inherited, modelBaseURL))
}

// NodeProxyFingerprintFromEnv hashes the canonical proxy entries already
// projected into a child environment slice.
func NodeProxyFingerprintFromEnv(env []string) string {
	var httpProxy, httpsProxy, noProxy, useProxy string
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "HTTP_PROXY":
			httpProxy = value
		case "HTTPS_PROXY":
			httpsProxy = value
		case "NO_PROXY":
			noProxy = value
		case "NODE_USE_ENV_PROXY":
			useProxy = value
		}
	}
	digest := sha256.Sum256([]byte(strings.Join([]string{httpProxy, httpsProxy, noProxy, useProxy}, "\x00")))
	return hex.EncodeToString(digest[:])
}

func nodeProxyEnvironmentWithMode(inherited []string, modelBaseURL string, mode Mode, systemReader func() systemProxySettings) []string {
	keys := map[string]bool{"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true, "NODE_USE_ENV_PROXY": true}
	stripProxyKeys := func() []string {
		out := make([]string, 0, len(inherited)+9)
		for _, entry := range inherited {
			key, _, _ := strings.Cut(entry, "=")
			if !keys[strings.ToUpper(key)] {
				out = append(out, entry)
			}
		}
		return out
	}
	if mode == ModeDirect {
		return append(stripProxyKeys(),
			"HTTP_PROXY=", "http_proxy=",
			"HTTPS_PROXY=", "https_proxy=",
			"NO_PROXY=*", "no_proxy=*",
			"ALL_PROXY=", "all_proxy=",
			"NODE_USE_ENV_PROXY=0",
		)
	}
	values := map[string]string{}
	for _, entry := range inherited {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	get := func(upper, lower string) string {
		if value := values[upper]; value != "" {
			return value
		}
		if value := values[lower]; value != "" {
			return value
		}
		// Windows environment names are case insensitive, including launcher-
		// supplied mixed-case names. Unix retains httpproxy's exact-name rules.
		if runtime.GOOS == "windows" {
			for i := len(inherited) - 1; i >= 0; i-- {
				key, value, _ := strings.Cut(inherited[i], "=")
				if strings.EqualFold(key, upper) {
					return value
				}
			}
		}
		return ""
	}
	config := httpproxy.Config{HTTPProxy: get("HTTP_PROXY", "http_proxy"), HTTPSProxy: get("HTTPS_PROXY", "https_proxy"), NoProxy: get("NO_PROXY", "no_proxy"), CGI: values["REQUEST_METHOD"] != ""}
	explicit := strings.TrimSpace(config.HTTPProxy) != "" || strings.TrimSpace(config.HTTPSProxy) != ""
	system := systemProxySettings{}
	if !explicit {
		system = systemReader()
	}
	resolved := config
	if !explicit {
		resolved.HTTPProxy, resolved.HTTPSProxy = system.config.HTTPProxy, system.config.HTTPSProxy
		resolved.NoProxy = strings.Trim(config.NoProxy+","+system.config.NoProxy, ",")
	}
	// Node requires a URL; Windows static proxy settings can be host:port.
	// Keep malformed explicit values as failures, never turn them into bypasses.
	valid := true
	normalize := func(raw string) string {
		if raw == "" {
			return ""
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			valid = false
		}
		return raw
	}
	resolved.HTTPProxy, resolved.HTTPSProxy = normalize(resolved.HTTPProxy), normalize(resolved.HTTPSProxy)
	bypass := []string{resolved.NoProxy, "localhost", "127.0.0.1", "::1", "[::1]"}
	if target, err := url.Parse(modelBaseURL); err == nil && target.Hostname() != "" && valid {
		var selected *url.URL
		if explicit {
			selected, err = config.ProxyFunc()(target)
		} else {
			selected, err = proxyWithSystem(target, config, system)
		}
		// Node fetch lacks Go's CIDR/<local> matching and uses HTTP_PROXY for
		// HTTPS when HTTPS_PROXY is absent. Project Go's decision for this origin.
		if err == nil && selected == nil {
			bypass = append(bypass, target.Hostname())
			if strings.Contains(target.Hostname(), ":") {
				bypass = append(bypass, "["+target.Hostname()+"]")
			}
		}
	}
	noProxy := strings.Trim(strings.Join(bypass, ","), ",")
	for _, item := range strings.Split(resolved.NoProxy, ",") {
		if strings.TrimSpace(item) == "*" {
			noProxy = "*"
			break
		}
	}
	useProxy := get("NODE_USE_ENV_PROXY", "NODE_USE_ENV_PROXY")
	if useProxy == "" {
		useProxy = "1"
	}
	return append(stripProxyKeys(), "HTTP_PROXY="+resolved.HTTPProxy, "http_proxy="+resolved.HTTPProxy,
		"HTTPS_PROXY="+resolved.HTTPSProxy, "https_proxy="+resolved.HTTPSProxy,
		"NO_PROXY="+noProxy, "no_proxy="+noProxy, "ALL_PROXY=", "all_proxy=", "NODE_USE_ENV_PROXY="+useProxy)
}
