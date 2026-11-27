// Package channelurl 是渠道 Base URL 与接口路径拼接的唯一实现。
// 生成任务和内置助手都从这里得出请求地址，同一个渠道在两处不能拼出不同的版本前缀。
package channelurl

import (
	"net/url"
	"strings"
)

const (
	BeefTVProductionHost   = "beeftv.cn"
	BeefTVLegacyHost       = "beeftv.app"
	BeefTVProductionOrigin = "https://" + BeefTVProductionHost
	BeefTVLegacyOrigin     = "https://" + BeefTVLegacyHost
	skillHubAPIPath        = "/api/beeftv/skillhub/v1"
)

// IsBeefTVHost reports whether host is an official BeefTV production host
// (primary beeftv.cn or legacy compatibility beeftv.app).
func IsBeefTVHost(host string) bool {
	normalized := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	return normalized == BeefTVProductionHost || normalized == BeefTVLegacyHost
}

// IsBeefTVManagedDomain reports whether host is an official BeefTV host or subdomain.
func IsBeefTVManagedDomain(host string) bool {
	normalized := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	return normalized == BeefTVProductionHost || strings.HasSuffix(normalized, "."+BeefTVProductionHost) ||
		normalized == BeefTVLegacyHost || strings.HasSuffix(normalized, "."+BeefTVLegacyHost)
}

// CanonicalBeefTVOrigin validates and normalizes an exact official BeefTV HTTPS
// origin (beeftv.cn or legacy beeftv.app), allowing an explicit default :443
// port and rejecting userinfo, non-HTTPS schemes, custom ports, paths, queries,
// or fragments.
func CanonicalBeefTVOrigin(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	if !strings.EqualFold(parsed.Scheme, "https") {
		return "", false
	}
	if strings.Trim(parsed.Path, "/") != "" {
		return "", false
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return "", false
	}
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(parsed.Hostname()), "."))
	switch host {
	case BeefTVProductionHost:
		return BeefTVProductionOrigin, true
	case BeefTVLegacyHost:
		return BeefTVLegacyOrigin, true
	default:
		return "", false
	}
}

// IsOfficialSkillHubEndpoint reports whether raw targets the official BeefTV
// SkillHub v1 API on either beeftv.cn or legacy beeftv.app.
func IsOfficialSkillHubEndpoint(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if !strings.EqualFold(parsed.Scheme, "https") {
		return false
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return false
	}
	if !IsBeefTVHost(parsed.Hostname()) {
		return false
	}
	return strings.TrimRight(parsed.Path, "/") == skillHubAPIPath
}

// SameOfficialSkillHubEndpoint reports whether two SkillHub endpoints both
// belong to the official BeefTV SkillHub market (beeftv.cn / beeftv.app).
func SameOfficialSkillHubEndpoint(a, b string) bool {
	return IsOfficialSkillHubEndpoint(a) && IsOfficialSkillHubEndpoint(b)
}

var apiPrefixes = []string{"/api/plan/v3", "/api/v3", "/api/v1", "/v1beta", "/v1", "/v2", "/v3", "/v4"}

// IsRawBase 判断渠道 Base URL 是否以单个 `#` 结尾：表示按原样使用该基础路径，不自动补齐默认版本前缀（如 `/v1`）。
// 带片段名的地址（如 `http://host#frag`）不当作无版本前缀标记。
func IsRawBase(value string) bool {
	trimmed := strings.TrimSpace(value)
	return strings.HasSuffix(trimmed, "#") && !strings.Contains(trimmed[:len(trimmed)-1], "#")
}

// CleanBase 去掉首尾空白、末尾 `#` 标记及多余斜杠，得到可解析的基础地址。
func CleanBase(value string) string {
	trimmed := strings.TrimSpace(value)
	if IsRawBase(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	if strings.ContainsAny(trimmed, "?#") {
		return trimmed
	}
	return strings.TrimRight(trimmed, "/")
}

// NormalizeBase 规范化保存或目录读取用的渠道 Base URL：保留末尾 `#` 无版本前缀标记，同时去掉多余斜杠。
func NormalizeBase(value string) string {
	clean := CleanBase(value)
	if clean == "" {
		return ""
	}
	if IsRawBase(value) {
		return clean + "#"
	}
	return clean
}

// Join 拼出完整请求地址：末尾带 `#` 时按原样使用基础路径且剥离协议模板自带的版本前缀；
// 常规地址中 baseURL 或 path 中显式出现的版本前缀优先，都没有时才补 defaultPrefix。
func Join(baseURL string, path string, defaultPrefix string) string {
	raw := IsRawBase(baseURL)
	base := CleanBase(baseURL)
	requestPath := strings.TrimSpace(path)
	if requestPath == "" {
		return base
	}
	if !strings.HasPrefix(requestPath, "/") {
		requestPath = "/" + requestPath
	}

	requestPrefix := requestAPIPathPrefix(requestPath)
	if raw {
		unversioned := requestPath
		if requestPrefix != "" {
			unversioned = requestPath[len(requestPrefix):]
		}
		if unversioned == "" {
			return base
		}
		if strings.HasPrefix(unversioned, "/") {
			if overlap := matchedRequestPathOverlap(base, unversioned); overlap > 0 {
				return base[:len(base)-overlap] + unversioned
			}
		}
		return base + unversioned
	}
	basePrefix := BasePrefix(base)
	if requestPrefix != "" {
		if basePrefix == requestPrefix {
			return base + strings.TrimPrefix(requestPath, requestPrefix)
		}
		trimmedBase := strings.TrimSuffix(base, basePrefix)
		if overlap := matchedRequestPathOverlap(trimmedBase, requestPath); overlap > 0 {
			return trimmedBase[:len(trimmedBase)-overlap] + requestPath
		}
		return trimmedBase + requestPath
	}
	if basePrefix != "" {
		if overlap := matchedRequestPathOverlap(base, requestPath); overlap > 0 {
			return base[:len(base)-overlap] + requestPath
		}
		return base + requestPath
	}
	prefixedPath := defaultPrefix + requestPath
	if overlap := matchedRequestPathOverlap(base, prefixedPath); overlap > 0 {
		return base[:len(base)-overlap] + prefixedPath
	}
	if overlap := matchedRequestPathOverlap(base, requestPath); overlap > 0 {
		return base[:len(base)-overlap] + requestPath
	}
	return base + prefixedPath
}

// BasePrefix 返回 baseURL 结尾已经带上的版本前缀，没有时返回空串。
func BasePrefix(value string) string {
	lower := strings.ToLower(CleanBase(value))
	for _, prefix := range apiPrefixes {
		if lower == prefix || strings.HasSuffix(lower, prefix) {
			return prefix
		}
	}
	return ""
}

func matchedRequestPathOverlap(base string, fullRequestPath string) int {
	pathOnly := fullRequestPath
	if idx := strings.IndexAny(pathOnly, "?#"); idx >= 0 {
		pathOnly = pathOnly[:idx]
	}
	pathOnly = strings.TrimRight(pathOnly, "/")
	if pathOnly == "" || pathOnly == "/" {
		return 0
	}
	lowerBase := strings.ToLower(base)
	lowerPath := strings.ToLower(pathOnly)
	if strings.HasSuffix(lowerBase, lowerPath) {
		return len(pathOnly)
	}
	if prefix := requestAPIPathPrefix(lowerPath); prefix != "" && len(lowerPath) > len(prefix)+1 {
		rest := lowerPath[len(prefix):]
		for _, endpoint := range unversionedEndpointCandidates(rest) {
			if strings.HasSuffix(lowerBase, prefix+endpoint) {
				return len(prefix) + len(endpoint)
			}
			for _, verPrefix := range apiPrefixes {
				if strings.HasSuffix(lowerBase, verPrefix+endpoint) {
					return len(verPrefix) + len(endpoint)
				}
			}
			if strings.HasSuffix(lowerBase, endpoint) {
				return len(endpoint)
			}
		}
	}
	return 0
}

func unversionedEndpointCandidates(rest string) []string {
	candidates := make([]string, 0, 4)
	addCandidate := func(path string) {
		if path == "" || path == "/" {
			return
		}
		candidates = append(candidates, path)
		if slash := strings.IndexByte(path[1:], '/'); slash > 0 {
			candidates = append(candidates, path[:1+slash])
		}
	}
	addCandidate(rest)
	if strings.HasPrefix(rest, "/query/") {
		addCandidate(strings.TrimPrefix(rest, "/query"))
	}
	return candidates
}

func requestAPIPathPrefix(value string) string {
	lower := strings.ToLower(value)
	for _, prefix := range apiPrefixes {
		if lower == prefix || strings.HasPrefix(lower, prefix+"/") || strings.HasPrefix(lower, prefix+"?") || strings.HasPrefix(lower, prefix+"#") {
			return prefix
		}
	}
	return ""
}
