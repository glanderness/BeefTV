package plugins

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

const (
	maxPartnerIconBytes  = 128 << 10
	partnerIconsSubdir   = "partner-icons"
	partnerIconIndexFile = "index.json"
)

type partnerIconIndexEntry struct {
	IconURL       string `json:"iconUrl"`
	RegistryStamp string `json:"registryStamp"`
	ContentHash   string `json:"contentHash,omitempty"`
	Ext           string `json:"ext,omitempty"`
	FailedAtUnix  int64  `json:"failedAtUnix,omitempty"`
	FailCount     int    `json:"failCount,omitempty"`
}

var (
	localSVGURLRefPattern     = regexp.MustCompile(`(?i)^url\(\s*#[A-Za-z0-9_.-]+\s*\)$`)
	partnerIconVersionPattern = regexp.MustCompile(`^[0-9a-f]{24,32}$`)
	partnerIconExts           = []string{".png", ".svg", ".jpg", ".webp"}
	allowedSVGElements        = map[string]bool{
		"svg":            true,
		"g":              true,
		"path":           true,
		"circle":         true,
		"ellipse":        true,
		"rect":           true,
		"line":           true,
		"polyline":       true,
		"polygon":        true,
		"defs":           true,
		"lineargradient": true,
		"radialgradient": true,
		"stop":           true,
		"clippath":       true,
		"mask":           true,
		"title":          true,
		"desc":           true,
	}
	partnerIconFlight = struct {
		sync.Mutex
		inFlight map[string]bool
	}{inFlight: map[string]bool{}}
	partnerIconIndexMu sync.Mutex
)

func (s *Service) partnerIconCacheDir() string {
	if s == nil || s.runtime == nil || strings.TrimSpace(s.runtime.dataDir) == "" {
		return ""
	}
	return filepath.Join(s.runtime.dataDir, "plugins", partnerIconsSubdir)
}

func readPartnerIconIndex(cacheDir string) map[string]partnerIconIndexEntry {
	out := map[string]partnerIconIndexEntry{}
	if cacheDir == "" {
		return out
	}
	partnerIconIndexMu.Lock()
	raw, err := os.ReadFile(filepath.Join(cacheDir, partnerIconIndexFile))
	partnerIconIndexMu.Unlock()
	if err != nil || len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return map[string]partnerIconIndexEntry{}
	}
	return out
}

func updatePartnerIconIndex(cacheDir, id string, mutate func(prev partnerIconIndexEntry) partnerIconIndexEntry) {
	if cacheDir == "" || id == "" {
		return
	}
	partnerIconIndexMu.Lock()
	defer partnerIconIndexMu.Unlock()
	indexPath := filepath.Join(cacheDir, partnerIconIndexFile)
	current := map[string]partnerIconIndexEntry{}
	if raw, err := os.ReadFile(indexPath); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &current)
	}
	if current == nil {
		current = map[string]partnerIconIndexEntry{}
	}
	current[id] = mutate(current[id])
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return
	}
	if encoded, err := json.Marshal(current); err == nil {
		_ = writePluginFile(indexPath, encoded)
	}
}

func partnerIconFailureBackedOff(entry partnerIconIndexEntry, iconURL, registryStamp string, now time.Time) bool {
	if entry.FailedAtUnix <= 0 || entry.FailCount <= 0 {
		return false
	}
	if entry.IconURL != iconURL || entry.RegistryStamp != registryStamp {
		return false
	}
	shift := min(entry.FailCount-1, 4)
	backoff := min(30*time.Minute, 2*time.Minute*time.Duration(1<<shift))
	return now.Before(time.Unix(entry.FailedAtUnix, 0).Add(backoff))
}

func validatePartnerIconURL(ctx context.Context, rawURL string) (*url.URL, bool, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.User != nil || parsed.Hostname() == "" || parsed.Fragment != "" {
		return nil, false, fmt.Errorf("无效的合作伙伴图标地址")
	}
	host := strings.ToLower(parsed.Hostname())
	if allowLoopbackMarketURLsForTest && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		(host == "127.0.0.1" || host == "localhost" || host == "::1") {
		return parsed, true, nil
	}
	validated, err := outbound.ValidateStrictPublicHTTPSURLContext(ctx, rawURL)
	if err != nil {
		return nil, false, err
	}
	return validated, false, nil
}

func doPartnerIconGetRequest(ctx context.Context, targetURL string, timeout time.Duration) (*http.Response, error) {
	_, isLoopbackTest, err := validatePartnerIconURL(ctx, targetURL)
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Accept", "image/svg+xml,image/png,image/webp,image/jpeg;q=0.9")

	var client *http.Client
	if isLoopbackTest {
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(redirectReq *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return errors.New("合作伙伴图标重定向次数过多")
				}
				_, _, redirectErr := validatePartnerIconURL(redirectReq.Context(), redirectReq.URL.String())
				return redirectErr
			},
		}
	} else {
		client = outbound.StrictPublicHTTPSClient(timeout)
	}
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	resp.Body = &contextClosingReadCloser{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

// validSanitizedPartnerSVG 使用严格 XML 解析与元素/属性白名单校验纯矢量图标，
// 允许标准 xmlns / xmlns:xlink 命名空间声明以及大小写无关的本地 url(#id) 渐变引用，
// 同时拒绝任何脚本、外部资源引用、xlink:* 属性、style、事件属性及实体扩展。
func validSanitizedPartnerSVG(data []byte) bool {
	if len(data) == 0 || len(data) > maxPartnerIconBytes {
		return false
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true
	seenRootSVG := false
	depth := 0
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return false
		}
		switch t := tok.(type) {
		case xml.Directive:
			return false
		case xml.ProcInst:
			if !strings.EqualFold(t.Target, "xml") {
				return false
			}
		case xml.StartElement:
			tag := strings.ToLower(strings.TrimSpace(t.Name.Local))
			if depth == 0 {
				if tag != "svg" {
					return false
				}
				seenRootSVG = true
			}
			depth++
			if depth > 32 || !allowedSVGElements[tag] {
				return false
			}
			for _, attr := range t.Attr {
				local := strings.ToLower(strings.TrimSpace(attr.Name.Local))
				space := strings.ToLower(strings.TrimSpace(attr.Name.Space))
				val := strings.TrimSpace(attr.Value)
				if space == "" && local == "xmlns" {
					if val != "http://www.w3.org/2000/svg" {
						return false
					}
					continue
				}
				if space == "xmlns" {
					if local != "xlink" || val != "http://www.w3.org/1999/xlink" {
						return false
					}
					continue
				}
				if strings.HasPrefix(local, "on") || local == "style" || local == "href" || space == "xlink" {
					return false
				}
				lowerVal := strings.ToLower(val)
				if strings.Contains(lowerVal, ":") || strings.Contains(lowerVal, "<") || strings.Contains(lowerVal, "//") {
					return false
				}
				if strings.Contains(lowerVal, "url") && strings.Contains(lowerVal, "(") && !localSVGURLRefPattern.MatchString(val) {
					return false
				}
			}
		case xml.EndElement:
			depth--
		}
	}
	return seenRootSVG && depth == 0
}

func partnerIconExtAndType(contentType string, data []byte) (string, string, bool) {
	trimmed := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	sniffed := strings.ToLower(http.DetectContentType(data))
	switch {
	case trimmed == "image/png" || sniffed == "image/png":
		return ".png", "image/png", true
	case trimmed == "image/jpeg" || sniffed == "image/jpeg":
		return ".jpg", "image/jpeg", true
	case trimmed == "image/webp" || sniffed == "image/webp":
		return ".webp", "image/webp", true
	case trimmed == "image/svg+xml" || bytes.Contains(bytes.ToLower(data[:min(len(data), 512)]), []byte("<svg")):
		if !validSanitizedPartnerSVG(data) {
			return "", "", false
		}
		return ".svg", "image/svg+xml", true
	default:
		return "", "", false
	}
}

func partnerIconContentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:16])
}

func findCachedPartnerIconByHash(cacheDir, id, contentHash string) (string, bool) {
	if cacheDir == "" || !partnerIconVersionPattern.MatchString(contentHash) {
		return "", false
	}
	for _, ext := range partnerIconExts {
		candidate := filepath.Join(cacheDir, id+"-"+contentHash+ext)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			return candidate, true
		}
	}
	return "", false
}

// cachedPartnerIconState 仅检查本地磁盘已缓存的内容哈希图标与退避状态，不在 GET 请求中发起网络抓取。
// 返回值：(iconRoute, needsSync)
func (s *Service) cachedPartnerIconState(id, iconURL, registryStamp string, now time.Time) (string, bool) {
	if iconURL == "" {
		return "", false
	}
	cacheDir := s.partnerIconCacheDir()
	if cacheDir == "" {
		return "", false
	}
	entry, exists := readPartnerIconIndex(cacheDir)[id]
	if exists && entry.IconURL == iconURL && entry.ContentHash != "" {
		if _, ok := findCachedPartnerIconByHash(cacheDir, id, entry.ContentHash); ok {
			route := fmt.Sprintf("/api/plugins/partners/%s/icon?v=%s", url.PathEscape(id), entry.ContentHash)
			// 当注册表版本戳更新时（如伙伴同 URL 替换了新图标字节），标记后台重新拉取校验，期间继续返回旧图标。
			needsRevalidate := entry.RegistryStamp != registryStamp && !partnerIconFailureBackedOff(entry, iconURL, registryStamp, now)
			return route, needsRevalidate
		}
	}
	if exists && partnerIconFailureBackedOff(entry, iconURL, registryStamp, now) {
		return "", false
	}
	return "", true
}

func (s *Service) refreshPartnerIcon(ctx context.Context, id, iconURL, registryStamp string) string {
	if iconURL == "" {
		return ""
	}
	now := time.Now()
	route, needsSync := s.cachedPartnerIconState(id, iconURL, registryStamp, now)
	if !needsSync {
		return route
	}
	cacheDir := s.partnerIconCacheDir()
	if cacheDir == "" || ctx == nil || ctx.Err() != nil {
		return route
	}
	flightKey := id + "|" + iconURL + "|" + registryStamp
	partnerIconFlight.Lock()
	if partnerIconFlight.inFlight[flightKey] {
		partnerIconFlight.Unlock()
		return route
	}
	partnerIconFlight.inFlight[flightKey] = true
	partnerIconFlight.Unlock()
	defer func() {
		partnerIconFlight.Lock()
		delete(partnerIconFlight.inFlight, flightKey)
		partnerIconFlight.Unlock()
	}()

	recordFailure := func() {
		updatePartnerIconIndex(cacheDir, id, func(prev partnerIconIndexEntry) partnerIconIndexEntry {
			count := 1
			if prev.IconURL == iconURL && prev.RegistryStamp == registryStamp {
				count = prev.FailCount + 1
			}
			// 若旧版同 URL 已有合法缓存，保留 ContentHash 供展示，同时记录本次失败退避防止无限重试。
			keepHash, keepExt := "", ""
			if prev.IconURL == iconURL {
				keepHash, keepExt = prev.ContentHash, prev.Ext
			}
			return partnerIconIndexEntry{
				IconURL:       iconURL,
				RegistryStamp: registryStamp,
				ContentHash:   keepHash,
				Ext:           keepExt,
				FailedAtUnix:  time.Now().Unix(),
				FailCount:     count,
			}
		})
	}

	resp, err := doPartnerIconGetRequest(ctx, iconURL, 2500*time.Millisecond)
	if err != nil {
		recordFailure()
		return route
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		recordFailure()
		return route
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxPartnerIconBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxPartnerIconBytes {
		recordFailure()
		return route
	}
	ext, _, ok := partnerIconExtAndType(resp.Header.Get("Content-Type"), data)
	if !ok {
		recordFailure()
		return route
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return route
	}
	contentHash := partnerIconContentHash(data)
	target := filepath.Join(cacheDir, id+"-"+contentHash+ext)
	if err := writePluginFile(target, data); err != nil {
		return route
	}
	updatePartnerIconIndex(cacheDir, id, func(_ partnerIconIndexEntry) partnerIconIndexEntry {
		return partnerIconIndexEntry{
			IconURL:       iconURL,
			RegistryStamp: registryStamp,
			ContentHash:   contentHash,
			Ext:           ext,
		}
	})
	return fmt.Sprintf("/api/plugins/partners/%s/icon?v=%s", url.PathEscape(id), contentHash)
}

func partnerIconMimeType(filePath string) string {
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(filePath)))
	if contentType == "" && strings.HasSuffix(strings.ToLower(filePath), ".svg") {
		return "image/svg+xml"
	}
	return contentType
}

// ResolvePartnerIconFile 按目录选定的内容哈希版本（?v=<hash>）从本地缓存读取已校验通过的合作伙伴图标文件。
func (s *Service) ResolvePartnerIconFile(id, version string) (string, string, error) {
	trimmedID := strings.TrimSpace(id)
	if !validCuratedBuiltinID(trimmedID) {
		return "", "", packageError(http.StatusNotFound, "partner_icon_not_found", "未找到合作伙伴图标")
	}
	cacheDir := s.partnerIconCacheDir()
	if cacheDir == "" {
		return "", "", packageError(http.StatusNotFound, "partner_icon_not_found", "未找到合作伙伴图标")
	}
	trimmedVersion := strings.ToLower(strings.TrimSpace(version))
	if trimmedVersion != "" {
		targetPath, ok := findCachedPartnerIconByHash(cacheDir, trimmedID, trimmedVersion)
		if !ok {
			return "", "", packageError(http.StatusNotFound, "partner_icon_not_found", "未找到合作伙伴图标")
		}
		return targetPath, partnerIconMimeType(targetPath), nil
	}
	if entry, ok := readPartnerIconIndex(cacheDir)[trimmedID]; ok && entry.ContentHash != "" {
		if targetPath, found := findCachedPartnerIconByHash(cacheDir, trimmedID, entry.ContentHash); found {
			return targetPath, partnerIconMimeType(targetPath), nil
		}
	}
	return "", "", packageError(http.StatusNotFound, "partner_icon_not_found", "未找到合作伙伴图标")
}
