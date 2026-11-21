package plugins

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CuratedRegistryURL and CuratedRegistryMirrorCDN are the authenticated public
// recommendation list endpoints for Sunnyender-org/beeftv-plugins. Only these
// two official repository origins are trusted for registry.json so the SHA-256
// pins inside registry.json cannot be tampered with by third-party proxies.
const (
	CuratedRegistryURL       = "https://raw.githubusercontent.com/Sunnyender-org/beeftv-plugins/main/registry.json"
	CuratedRegistryMirrorCDN = "https://cdn.jsdelivr.net/gh/Sunnyender-org/beeftv-plugins@main/registry.json"
	CuratedCatalogPackage    = "beeftv-plugin-catalog"

	curatedRegistryMemTTL = 2 * time.Minute
)

var (
	curatedRegistryMemCache = struct {
		sync.Mutex
		raw        []byte
		fetchedAt  time.Time
		pinnedTest bool
	}{}
	curatedRegistryFileMu sync.Mutex
)

// CuratedMarket serves local recommendations immediately when cached is set.
// The client refreshes the catalog separately, without waiting for npm search.
func (s *Service) CuratedMarket(ctx context.Context, registry string, cached bool) []MarketPluginItem {
	if normalized, err := NormalizeNpmRegistry(registry); err == nil {
		registry = normalized
	} else {
		registry = NpmMirrorRegistry
	}
	installed := map[string]View{}
	cachePath := ""
	if s != nil {
		if s.runtime != nil && strings.TrimSpace(s.runtime.dataDir) != "" {
			cachePath = filepath.Join(s.runtime.dataDir, "plugins", "market-registry-cache.json")
		}
		for _, item := range s.List() {
			installed[item.Manifest.ID] = item
		}
	}
	if !cached {
		return loadCuratedRegistryItemsWithCache(ctx, "", registry, cachePath, installed)
	}
	curatedRegistryMemCache.Lock()
	raw := append([]byte(nil), curatedRegistryMemCache.raw...)
	curatedRegistryMemCache.Unlock()
	if len(raw) == 0 {
		raw = readCuratedRegistryWithCache(nil, registry, cachePath)
	}
	return curatedRegistryItems(nil, raw, "", registry, installed)
}

type curatedRegistryEntry struct {
	ID            string   `json:"id"`
	PackageName   string   `json:"packageName"`
	Npm           string   `json:"npm"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Description   string   `json:"description"`
	Author        string   `json:"author"`
	Category      string   `json:"category"`
	Recommended   bool     `json:"recommended"`
	Repo          string   `json:"repo"`
	Homepage      string   `json:"homepage"`
	Readme        string   `json:"readme"`
	Tarball       string   `json:"tarball"`
	MirrorTarball string   `json:"mirrorTarball"`
	SHA256        string   `json:"sha256"`
	Tags          []string `json:"tags"`
	Partner       bool     `json:"partner,omitempty"`
	PresetID      string   `json:"presetId,omitempty"`
	From          string   `json:"from,omitempty"`
	Until         string   `json:"until,omitempty"`
	KeysURL       string   `json:"keysUrl,omitempty"`
	WebsiteURL    string   `json:"websiteUrl,omitempty"`
	IconURL       string   `json:"iconUrl,omitempty"`
	PromoText     string   `json:"promoText,omitempty"`
}

type curatedRegistryPayload struct {
	UpdatedAt string                 `json:"updatedAt,omitempty"`
	Plugins   []curatedRegistryEntry `json:"plugins"`
	// Builtins 登记随桌面版预装的官方内置插件在线热更新包（带 SHA-256 校验），不混入插件市场未安装卡片。
	Builtins []curatedRegistryEntry `json:"builtins,omitempty"`
	// Packages 只写 npm 包名，名称、说明和版本从 npm 读，上架只需加一行。
	// 已发布的旧版 BeefTV 不认这个键，会直接忽略，不会出现缺信息的卡片。
	Packages []string `json:"packages"`
}

func curatedRegistryUpdatedAt(raw []byte) string {
	var meta struct {
		UpdatedAt string `json:"updatedAt"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &meta) != nil {
		return ""
	}
	return strings.TrimSpace(meta.UpdatedAt)
}

func curatedRegistryTimestamp(raw []byte) (time.Time, bool) {
	stamp := curatedRegistryUpdatedAt(raw)
	if stamp == "" {
		return time.Time{}, false
	}
	return parsePartnerBoundTime(stamp, false)
}

func curatedRegistryAtLeastAsFresh(candidate, baseline []byte) bool {
	if len(baseline) == 0 {
		return true
	}
	candTime, candOK := curatedRegistryTimestamp(candidate)
	baseTime, baseOK := curatedRegistryTimestamp(baseline)
	if !baseOK {
		return true
	}
	if !candOK {
		return false
	}
	return !candTime.Before(baseTime)
}

func validCuratedRegistryPayload(raw []byte) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return false
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	return payload.Plugins != nil
}

func curatedRegistryCandidateURLs(registry string) []string {
	isChina := strings.TrimSpace(registry) == "" || strings.Contains(registry, "npmmirror.com")
	if isChina {
		return []string{
			CuratedRegistryMirrorCDN,
			CuratedRegistryURL,
		}
	}
	return []string{
		CuratedRegistryURL,
		CuratedRegistryMirrorCDN,
	}
}

func readBundledCuratedRegistry() []byte {
	if marketDir, ok := BundledSampleDir("beeftv-plugin-market"); ok {
		if bundled, err := os.ReadFile(filepath.Join(marketDir, "registry.json")); err == nil && validCuratedRegistryPayload(bundled) {
			return bundled
		}
	}
	return nil
}

func readLocalCuratedRegistryBaseline(cachePath string) []byte {
	var best []byte
	if strings.TrimSpace(cachePath) != "" {
		curatedRegistryFileMu.Lock()
		cached, err := os.ReadFile(cachePath)
		curatedRegistryFileMu.Unlock()
		if err == nil && validCuratedRegistryPayload(cached) {
			best = cached
		}
	}
	if bundled := readBundledCuratedRegistry(); len(bundled) > 0 {
		if len(best) == 0 {
			return bundled
		}
		_, cachedHasDate := curatedRegistryTimestamp(best)
		if cachedHasDate {
			if !curatedRegistryAtLeastAsFresh(best, bundled) {
				return bundled
			}
			return best
		}
		// 兼容旧版未带 updatedAt 的本地缓存：保留其已缓存的市场插件条目，并按 ID 合并补齐随包最新的 builtins（同 ID 以随包为准）。
		var cachedDoc, bundledDoc curatedRegistryPayload
		if json.Unmarshal(best, &cachedDoc) == nil && json.Unmarshal(bundled, &bundledDoc) == nil {
			if len(bundledDoc.Builtins) > 0 {
				bundledByID := make(map[string]curatedRegistryEntry, len(bundledDoc.Builtins))
				for _, entry := range bundledDoc.Builtins {
					bundledByID[strings.TrimSpace(entry.ID)] = entry
				}
				mergedBuiltins := make([]curatedRegistryEntry, 0, len(cachedDoc.Builtins)+len(bundledDoc.Builtins))
				seen := map[string]bool{}
				for _, entry := range cachedDoc.Builtins {
					id := strings.TrimSpace(entry.ID)
					if newer, exists := bundledByID[id]; exists {
						mergedBuiltins = append(mergedBuiltins, newer)
					} else {
						mergedBuiltins = append(mergedBuiltins, entry)
					}
					seen[id] = true
				}
				for _, entry := range bundledDoc.Builtins {
					id := strings.TrimSpace(entry.ID)
					if !seen[id] {
						mergedBuiltins = append(mergedBuiltins, entry)
						seen[id] = true
					}
				}
				cachedDoc.Builtins = mergedBuiltins
			}
			if cachedDoc.UpdatedAt == "" {
				cachedDoc.UpdatedAt = bundledDoc.UpdatedAt
			}
			if merged, err := json.Marshal(cachedDoc); err == nil {
				return merged
			}
		}
		return bundled
	}
	return best
}

func readCuratedRegistryWithCache(ctx context.Context, registry, cachePath string) []byte {
	raw, _ := readCuratedRegistryWithMeta(ctx, registry, cachePath)
	return raw
}

// readCuratedRegistryWithMeta 返回精选注册表字节与是否已同远端权威源确认（remoteVerified=true 表示可安全裁剪已移除动态项）。
func readCuratedRegistryWithMeta(ctx context.Context, registry, cachePath string) ([]byte, bool) {
	bundled := readBundledCuratedRegistry()
	baseline := readLocalCuratedRegistryBaseline(cachePath)
	if ctx != nil && ctx.Err() == nil {
		curatedRegistryMemCache.Lock()
		if len(curatedRegistryMemCache.raw) > 0 && (curatedRegistryMemCache.pinnedTest || time.Since(curatedRegistryMemCache.fetchedAt) < curatedRegistryMemTTL) {
			cached := append([]byte(nil), curatedRegistryMemCache.raw...)
			isPinnedTest := curatedRegistryMemCache.pinnedTest
			curatedRegistryMemCache.Unlock()
			_, cachedHasDate := curatedRegistryTimestamp(cached)
			if isPinnedTest || !cachedHasDate || curatedRegistryAtLeastAsFresh(cached, baseline) {
				return cached, true
			}
		} else {
			curatedRegistryMemCache.Unlock()
		}

		for _, candidateURL := range curatedRegistryCandidateURLs(registry) {
			if ctx.Err() != nil {
				break
			}
			resp, err := doMarketGetRequest(ctx, candidateURL, 2500*time.Millisecond, "application/json")
			if err != nil {
				continue
			}
			raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK || readErr != nil || !validCuratedRegistryPayload(raw) {
				continue
			}
			// 镜像 CDN 必须不旧于本地基线，防止边缘节点缓存滞后回退；GitHub 主分支源只需不旧于随包基线，允许同日追加新合作伙伴立即生效。
			compareFloor := baseline
			if candidateURL == CuratedRegistryURL {
				compareFloor = bundled
			}
			if curatedRegistryAtLeastAsFresh(raw, compareFloor) {
				curatedRegistryMemCache.Lock()
				curatedRegistryMemCache.raw = append([]byte(nil), raw...)
				curatedRegistryMemCache.fetchedAt = time.Now()
				curatedRegistryMemCache.pinnedTest = false
				curatedRegistryMemCache.Unlock()
				saveCuratedRegistryCache(cachePath, raw)
				return raw, true
			}
		}
	}
	return baseline, false
}

func saveCuratedRegistryCache(cachePath string, raw []byte) {
	if strings.TrimSpace(cachePath) == "" || !validCuratedRegistryPayload(raw) {
		return
	}
	curatedRegistryFileMu.Lock()
	defer curatedRegistryFileMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return
	}
	_ = writePluginFile(cachePath, raw)
}

func loadCuratedRegistryItems(ctx context.Context, query string, installed map[string]View) []MarketPluginItem {
	return loadCuratedRegistryItemsWithCache(ctx, query, NpmMirrorRegistry, "", installed)
}

func loadCuratedRegistryItemsWithCache(ctx context.Context, query, registry, cachePath string, installed map[string]View) []MarketPluginItem {
	raw := readCuratedRegistryWithCache(ctx, registry, cachePath)
	return curatedRegistryItems(ctx, raw, query, registry, installed)
}

func curatedRegistryItems(ctx context.Context, raw []byte, query, registry string, installed map[string]View) []MarketPluginItem {
	if len(raw) == 0 {
		return nil
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	out := make([]MarketPluginItem, 0, len(payload.Plugins)+len(payload.Packages))
	listed := map[string]bool{}
	for _, item := range payload.Plugins {
		listed[strings.TrimSpace(item.PackageName)], listed[strings.TrimSpace(item.Npm)], listed[strings.TrimSpace(item.ID)] = true, true, true
	}
	for _, item := range payload.Plugins {
		if q != "" &&
			!strings.Contains(strings.ToLower(item.ID), q) &&
			!strings.Contains(strings.ToLower(item.PackageName), q) &&
			!strings.Contains(strings.ToLower(item.Name), q) &&
			!strings.Contains(strings.ToLower(item.Description), q) {
			continue
		}
		inst, isInstalled := installed[item.ID]
		pkgName := strings.TrimSpace(item.PackageName)
		if pkgName == "" {
			pkgName = strings.TrimSpace(item.Npm)
		}
		if pkgName == "" {
			pkgName = item.ID
		}
		_, bundled := BundledSampleDir(pkgName)
		repo := strings.TrimSpace(item.Repo)
		homepage := strings.TrimSpace(item.Homepage)
		if homepage == "" {
			homepage = repo
		}
		out = append(out, MarketPluginItem{
			ID:            item.ID,
			Name:          item.Name,
			PackageName:   pkgName,
			Version:       item.Version,
			Description:   item.Description,
			Author:        item.Author,
			Keywords:      item.Tags,
			Tags:          item.Tags,
			Repository:    repo,
			Homepage:      homepage,
			ReadmeURL:     strings.TrimSpace(item.Readme),
			TarballURL:    strings.TrimSpace(item.Tarball),
			MirrorTarball: strings.TrimSpace(item.MirrorTarball),
			SHA256:        strings.TrimSpace(item.SHA256),
			Installed:     isInstalled,
			Enabled:       isInstalled && inst.Status == StatusEnabled,
			Recommended:   item.Recommended,
			Category:      item.Category,
			Bundled:       bundled,
		})
	}
	if ctx == nil {
		return out
	}
	return append(out, listedPackageItems(ctx, payload.Packages, listed, q, registry, installed)...)
}

// listedPackageItems 把精选列表里只写包名的条目补全成市场卡片，查不到 npm 的跳过。
func listedPackageItems(ctx context.Context, names []string, listed map[string]bool, query, registry string, installed map[string]View) []MarketPluginItem {
	items := make([]MarketPluginItem, len(names))
	found := make([]bool, len(names))
	var wg sync.WaitGroup
	for index, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || listed[name] {
			continue
		}
		listed[name] = true
		wg.Add(1)
		go func(index int, name string) {
			defer wg.Done()
			items[index], found[index] = fetchNpmPackageSummary(ctx, name, registry)
		}(index, name)
	}
	wg.Wait()
	out := make([]MarketPluginItem, 0, len(names))
	for index, item := range items {
		if !found[index] {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(item.PackageName), query) && !strings.Contains(strings.ToLower(item.Name), query) && !strings.Contains(strings.ToLower(item.Description), query) {
			continue
		}
		inst, isInstalled := installed[item.ID]
		item.Installed, item.Enabled, item.Recommended = isInstalled, isInstalled && inst.Status == StatusEnabled, true
		out = append(out, item)
	}
	return out
}

func lookupCuratedPluginEntry(ctx context.Context, idOrSpec, registry, cachePath string) (curatedRegistryEntry, bool) {
	target := strings.TrimSpace(idOrSpec)
	if target == "" {
		return curatedRegistryEntry{}, false
	}
	raw := readCuratedRegistryWithCache(ctx, registry, cachePath)
	if len(raw) == 0 {
		return curatedRegistryEntry{}, false
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return curatedRegistryEntry{}, false
	}
	for _, entry := range append(payload.Plugins, payload.Builtins...) {
		if entry.ID == target || entry.PackageName == target || entry.Npm == target {
			return entry, true
		}
	}
	return curatedRegistryEntry{}, false
}
