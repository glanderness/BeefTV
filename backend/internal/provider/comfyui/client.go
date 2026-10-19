package comfyui

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/outbound"
)

// ValidateURL normalizes a native ComfyUI origin. Transport itself remains in
// BeefTV's outbound executor so this connector follows the current deployment's
// private-upstream policy instead of carrying Seal's older policy forward.
func ValidateURL(raw string) (*url.URL, error) {
	value := strings.TrimRight(strings.TrimSpace(raw), "/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("ComfyUI 地址必须是完整的 HTTP(S) 服务地址")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return nil, fmt.Errorf("ComfyUI 地址不能包含路径")
	}
	if _, err := outbound.ValidateOutboundURL(parsed.String()); err != nil {
		return nil, err
	}
	return parsed, nil
}

// HostIsLoopback is retained for policy tests and diagnostics. Native ComfyUI
// may intentionally live on an explicitly configured LAN host.
func HostIsLoopback(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
