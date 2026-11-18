package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type partnerRecordedError struct {
	Message string
	Kind    string
}

var (
	curatedBuiltinIDPattern = regexp.MustCompile(`^beeftv-plugin-[a-z0-9][a-z0-9-]{0,49}$`)
	partnerPresetIDPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,40}$`)
	chinaPartnerTZ          = time.FixedZone("CST", 8*3600)
	reservedCorePresetIDs   = map[string]bool{
		"compatible": true,
		"openai":     true,
		"gemini":     true,
		"ark":        true,
		"beeftv":     true,
	}
	partnerInstallFlight = struct {
		sync.Mutex
		inFlight map[string]bool
		errors   map[string]partnerRecordedError
	}{
		inFlight: map[string]bool{},
		errors:   map[string]partnerRecordedError{},
	}
)

// PartnerDescriptor 描述「连接你的模型服务」左侧「合作伙伴」分区的远端上下架与返佣信息。
type PartnerDescriptor struct {
	ID               string `json:"id"`
	PresetID         string `json:"presetId"`
	Name             string `json:"name"`
	Live             bool   `json:"live"`
	Retired          bool   `json:"retired,omitempty"`
	Installed        bool   `json:"installed"`
	RepairNeeded     bool   `json:"repairNeeded,omitempty"`
	Enabled          bool   `json:"enabled"`
	IconPending      bool   `json:"iconPending,omitempty"`
	InstallError     string `json:"installError,omitempty"`
	InstallErrorKind string `json:"installErrorKind,omitempty"`
	From             string `json:"from,omitempty"`
	Until            string `json:"until,omitempty"`
	KeysURL          string `json:"keysUrl,omitempty"`
	WebsiteURL       string `json:"websiteUrl,omitempty"`
	IconURL          string `json:"iconUrl,omitempty"`
	PromoText        string `json:"promoText,omitempty"`
}

// PartnerCatalogResult 同时携带合作伙伴列表与本次结果是否来自远端权威完整快照（离线降级时 Complete=false，前端不裁剪已安装伙伴）。
type PartnerCatalogResult struct {
	Partners []PartnerDescriptor `json:"partners"`
	Complete bool                `json:"complete"`
}

func validCuratedBuiltinID(id string) bool {
	trimmed := strings.TrimSpace(id)
	return curatedBuiltinIDPattern.MatchString(trimmed) && !IsReservedApplication(trimmed)
}

func validPartnerPresetID(id string) bool {
	trimmed := strings.TrimSpace(id)
	return partnerPresetIDPattern.MatchString(trimmed) && !reservedCorePresetIDs[trimmed]
}

func derivePartnerPresetID(entry curatedRegistryEntry) string {
	if explicit := strings.TrimSpace(entry.PresetID); explicit != "" {
		return explicit
	}
	switch strings.TrimSpace(entry.ID) {
	case "beeftv-plugin-ll2":
		return "ll2"
	case "beeftv-plugin-ysdui":
		return "ysdui"
	default:
		return strings.TrimPrefix(strings.TrimSpace(entry.ID), "beeftv-plugin-")
	}
}

func sanitizeHTTPSURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 2048 {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.User != nil || parsed.Hostname() == "" || parsed.Fragment != "" {
		return ""
	}
	if parsed.Scheme == "https" {
		return parsed.String()
	}
	if allowLoopbackMarketURLsForTest && parsed.Scheme == "http" &&
		(parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1") {
		return parsed.String()
	}
	return ""
}

func parsePartnerBoundTime(raw string, endOfDay bool) (time.Time, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return time.Time{}, true
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed, true
		}
	}
	// 纯日期 YYYY-MM-DD 统一按东八区（UTC+8）自然日起止解释，until 含当天 23:59:59。
	if parsedDate, err := time.ParseInLocation("2006-01-02", trimmed, chinaPartnerTZ); err == nil {
		if endOfDay {
			return parsedDate.AddDate(0, 0, 1), true
		}
		return parsedDate, true
	}
	return time.Time{}, false
}

func curatedEntryLiveAt(fromRaw, untilRaw string, now time.Time) bool {
	fromTime, okFrom := parsePartnerBoundTime(fromRaw, false)
	untilTime, okUntil := parsePartnerBoundTime(untilRaw, true)
	if !okFrom || !okUntil {
		return false
	}
	if !fromTime.IsZero() && now.Before(fromTime) {
		return false
	}
	if !untilTime.IsZero() && !now.Before(untilTime) {
		return false
	}
	return true
}

func isPartnerBuiltinEntry(entry curatedRegistryEntry) bool {
	if !validCuratedBuiltinID(entry.ID) {
		return false
	}
	return entry.Partner || strings.EqualFold(strings.TrimSpace(entry.Category), "channel")
}

func lookupCuratedBuiltinEntry(ctx context.Context, pkgName, registry, cachePath string) (curatedRegistryEntry, bool) {
	trimmed := strings.TrimSpace(pkgName)
	if !validCuratedBuiltinID(trimmed) {
		return curatedRegistryEntry{}, false
	}
	raw := readCuratedRegistryWithCache(ctx, marketRegistry(registry), cachePath)
	if len(raw) == 0 {
		return curatedRegistryEntry{}, false
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return curatedRegistryEntry{}, false
	}
	for _, entry := range payload.Builtins {
		if strings.TrimSpace(entry.ID) == trimmed || strings.TrimSpace(entry.PackageName) == trimmed {
			return entry, true
		}
	}
	return curatedRegistryEntry{}, false
}

func partnerErrorKey(s *Service, id string) string {
	dataDir := ""
	if s != nil && s.runtime != nil {
		dataDir = s.runtime.dataDir
	}
	return dataDir + "|" + id
}

func getPartnerInstallError(s *Service, id string) (string, string) {
	partnerInstallFlight.Lock()
	defer partnerInstallFlight.Unlock()
	rec := partnerInstallFlight.errors[partnerErrorKey(s, id)]
	return rec.Message, rec.Kind
}

func setPartnerInstallError(s *Service, id, errMsg, kind string) {
	key := partnerErrorKey(s, id)
	partnerInstallFlight.Lock()
	defer partnerInstallFlight.Unlock()
	if strings.TrimSpace(errMsg) == "" {
		delete(partnerInstallFlight.errors, key)
	} else {
		if kind == "" {
			kind = "transient"
		}
		partnerInstallFlight.errors[key] = partnerRecordedError{
			Message: strings.TrimSpace(errMsg),
			Kind:    kind,
		}
	}
}

func isHealthyOfficialPartnerInstalled(dataDir, id, expectedVersion, expectedSHA string, inst View) bool {
	if !IsBuiltInSource(inst.Source) {
		return false
	}
	if isBundledBuiltinPlugin(id) {
		return true
	}
	if strings.TrimSpace(inst.PackageDir) == "" || strings.TrimSpace(inst.SHA256) == "" {
		return false
	}
	normExpectedSHA := strings.ToLower(strings.TrimSpace(expectedSHA))
	if validPackageSHA256(normExpectedSHA) &&
		strings.TrimSpace(inst.ArchiveSHA256) != "" &&
		strings.TrimSpace(expectedVersion) == strings.TrimSpace(inst.Manifest.Version) &&
		!strings.EqualFold(normExpectedSHA, strings.TrimSpace(inst.ArchiveSHA256)) {
		return false
	}
	_, ok := verifyHotUpdatedBuiltinDir(dataDir, id, inst.PackageDir, inst.SHA256)
	return ok
}

func partnerRegistryStamp(entry curatedRegistryEntry, updatedAt string) string {
	return strings.TrimSpace(entry.Version) + "|" + strings.TrimSpace(updatedAt)
}

func localConflictMessage(id string) string {
	return fmt.Sprintf("本地已安装同名非官方插件 %s，请先在插件中心卸载后再同步官方合作伙伴预设", id)
}

// PartnerCatalogSnapshot 纯只读返回官方精选注册表中的合作伙伴状态、远端完整性标记与本地已缓存图标，不在 GET 请求中发起第三方图标抓取或系统安装。
func (s *Service) PartnerCatalogSnapshot(ctx context.Context, registry string) PartnerCatalogResult {
	return s.partnerCatalogSnapshotAt(ctx, registry, time.Now())
}

func (s *Service) partnerCatalogSnapshotAt(ctx context.Context, registry string, now time.Time) PartnerCatalogResult {
	if s == nil {
		return PartnerCatalogResult{Partners: []PartnerDescriptor{}, Complete: false}
	}
	reg := marketRegistry(registry)
	raw, remoteVerified := readCuratedRegistryWithMeta(ctx, reg, s.marketCachePath())
	if len(raw) == 0 {
		return PartnerCatalogResult{Partners: []PartnerDescriptor{}, Complete: false}
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return PartnerCatalogResult{Partners: []PartnerDescriptor{}, Complete: false}
	}
	dataDir := ""
	if s.runtime != nil {
		dataDir = s.runtime.dataDir
	}
	installed := map[string]View{}
	for _, item := range s.List() {
		installed[item.Manifest.ID] = item
	}
	out := make([]PartnerDescriptor, 0, len(payload.Builtins)+len(installed))
	seenPresets := map[string]bool{}
	seenPluginIDs := map[string]bool{}
	for _, entry := range payload.Builtins {
		if !isPartnerBuiltinEntry(entry) {
			continue
		}
		id := strings.TrimSpace(entry.ID)
		presetID := derivePartnerPresetID(entry)
		if !validPartnerPresetID(presetID) || seenPresets[presetID] {
			continue
		}
		seenPresets[presetID] = true
		seenPluginIDs[id] = true
		live := curatedEntryLiveAt(entry.From, entry.Until, now)
		inst, hasRecord := installed[id]
		isOfficialInstalled := hasRecord && isHealthyOfficialPartnerInstalled(dataDir, id, entry.Version, entry.SHA256, inst)
		repairNeeded := hasRecord && IsBuiltInSource(inst.Source) && !isOfficialInstalled
		websiteURL := sanitizeHTTPSURL(entry.WebsiteURL)
		if websiteURL == "" {
			websiteURL = sanitizeHTTPSURL(entry.Homepage)
		}
		keysURL := sanitizeHTTPSURL(entry.KeysURL)
		cleanRemoteIcon := sanitizeHTTPSURL(entry.IconURL)
		stamp := partnerRegistryStamp(entry, payload.UpdatedAt)
		iconRoute, iconNeedsSync := s.cachedPartnerIconState(id, cleanRemoteIcon, stamp, now)
		installErr, installErrKind := "", ""
		// 本地同名非官方插件包冲突始终具有最高优先级，不被历史瞬时下载报错遮蔽。
		if hasRecord && !IsBuiltInSource(inst.Source) {
			installErr = localConflictMessage(id)
			installErrKind = "conflict"
		} else if !isOfficialInstalled {
			installErr, installErrKind = getPartnerInstallError(s, id)
		}
		out = append(out, PartnerDescriptor{
			ID:               id,
			PresetID:         presetID,
			Name:             strings.TrimSpace(entry.Name),
			Live:             live,
			Installed:        isOfficialInstalled,
			RepairNeeded:     repairNeeded,
			Enabled:          isOfficialInstalled && inst.Status == StatusEnabled,
			IconPending:      live && cleanRemoteIcon != "" && iconNeedsSync,
			InstallError:     installErr,
			InstallErrorKind: installErrKind,
			From:             strings.TrimSpace(entry.From),
			Until:            strings.TrimSpace(entry.Until),
			KeysURL:          keysURL,
			WebsiteURL:       websiteURL,
			IconURL:          iconRoute,
			PromoText:        strings.TrimSpace(entry.PromoText),
		})
	}
	// 对已在本机安装的官方动态合作伙伴，仅在远端权威目录确认已移除（remoteVerified=true）时补充 Retired=true, Live=false 条目；
	// 离线本地缓存降级（remoteVerified=false）不发合成退役项，避免覆盖前端已加载的在期伙伴元数据。
	if remoteVerified {
		retiredIDs := make([]string, 0, len(installed))
		for id, inst := range installed {
			if !seenPluginIDs[id] && !isBundledBuiltinPlugin(id) && IsBuiltInSource(inst.Source) && validCuratedBuiltinID(id) {
				retiredIDs = append(retiredIDs, id)
			}
		}
		sort.Strings(retiredIDs)
		for _, id := range retiredIDs {
			inst := installed[id]
			presetID := firstNonBlank(inst.PartnerPresetID, derivePartnerPresetID(curatedRegistryEntry{ID: id}))
			if !validPartnerPresetID(presetID) || seenPresets[presetID] {
				continue
			}
			seenPresets[presetID] = true
			healthy := isHealthyOfficialPartnerInstalled(dataDir, id, "", "", inst)
			out = append(out, PartnerDescriptor{
				ID:        id,
				PresetID:  presetID,
				Name:      strings.TrimSpace(inst.Manifest.Name),
				Live:      false,
				Retired:   true,
				Installed: healthy,
				Enabled:   healthy && inst.Status == StatusEnabled,
			})
		}
	}
	return PartnerCatalogResult{Partners: out, Complete: remoteVerified}
}

func tryAcquirePartnerInstall(key string) (func(), bool) {
	partnerInstallFlight.Lock()
	defer partnerInstallFlight.Unlock()
	if partnerInstallFlight.inFlight[key] {
		return nil, false
	}
	partnerInstallFlight.inFlight[key] = true
	return func() {
		partnerInstallFlight.Lock()
		delete(partnerInstallFlight.inFlight, key)
		partnerInstallFlight.Unlock()
	}, true
}

// InstallMissingLiveBuiltins 按可取消 ctx 与按 ID 单飞锁预装或修复在期合作伙伴插件、刷新远端缓存图标，并记录和返回安装错误。
func (s *Service) InstallMissingLiveBuiltins(ctx context.Context, registry string) map[string]string {
	errs := map[string]string{}
	if s == nil || s.runtime == nil {
		return errs
	}
	if ctx == nil {
		ctx = context.Background()
	}
	reg := marketRegistry(registry)
	raw := readCuratedRegistryWithCache(ctx, reg, s.marketCachePath())
	if len(raw) == 0 {
		return errs
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return errs
	}
	installed := map[string]View{}
	for _, item := range s.List() {
		installed[item.Manifest.ID] = item
	}
	now := time.Now()
	for _, entry := range payload.Builtins {
		if ctx.Err() != nil {
			return errs
		}
		id := strings.TrimSpace(entry.ID)
		if !validCuratedBuiltinID(id) {
			continue
		}
		live := curatedEntryLiveAt(entry.From, entry.Until, now)
		inst, exists := installed[id]
		needsInstalledRepair := exists && IsBuiltInSource(inst.Source) && !isHealthyOfficialPartnerInstalled(s.runtime.dataDir, id, entry.Version, entry.SHA256, inst)
		if !live && !needsInstalledRepair {
			continue
		}
		if live {
			if cleanIcon := sanitizeHTTPSURL(entry.IconURL); cleanIcon != "" {
				_ = s.refreshPartnerIcon(ctx, id, cleanIcon, partnerRegistryStamp(entry, payload.UpdatedAt))
			}
		}
		if exists {
			if !IsBuiltInSource(inst.Source) {
				msg := localConflictMessage(id)
				setPartnerInstallError(s, id, msg, "conflict")
				errs[id] = msg
				continue
			}
			if !needsInstalledRepair {
				setPartnerInstallError(s, id, "", "")
				continue
			}
		}
		if !validPackageSHA256(strings.ToLower(strings.TrimSpace(entry.SHA256))) ||
			(strings.TrimSpace(entry.Tarball) == "" && strings.TrimSpace(entry.MirrorTarball) == "") {
			msg := fmt.Sprintf("合作伙伴插件 %s 缺少有效的下载地址或 SHA-256 校验值", id)
			setPartnerInstallError(s, id, msg, "transient")
			errs[id] = msg
			continue
		}
		flightKey := partnerErrorKey(s, id)
		release, acquired := tryAcquirePartnerInstall(flightKey)
		if !acquired {
			continue
		}
		_, err := s.InstallPackageContext(ctx, id, reg)
		release()
		if err != nil {
			log.Printf("预装官方合作伙伴插件 %s 失败：%v", id, err)
			setPartnerInstallError(s, id, err.Error(), "transient")
			errs[id] = err.Error()
			continue
		}
		setPartnerInstallError(s, id, "", "")
	}
	return errs
}

// NextPartnerSyncDelay 根据本地缓存注册表中最近的未到起止时间点（from/until）缩短下一轮伙伴巡检间隔。
func (s *Service) NextPartnerSyncDelay(defaultDelay time.Duration, now time.Time) time.Duration {
	delay := defaultDelay
	if s == nil {
		return delay
	}
	raw := readLocalCuratedRegistryBaseline(s.marketCachePath())
	curatedRegistryMemCache.Lock()
	if len(curatedRegistryMemCache.raw) > 0 {
		raw = append([]byte(nil), curatedRegistryMemCache.raw...)
	}
	curatedRegistryMemCache.Unlock()
	if len(raw) == 0 {
		return delay
	}
	var payload curatedRegistryPayload
	if json.Unmarshal(raw, &payload) != nil {
		return delay
	}
	for _, entry := range payload.Builtins {
		for _, candidate := range []struct {
			raw string
			end bool
		}{{entry.From, false}, {entry.Until, true}} {
			if strings.TrimSpace(candidate.raw) == "" {
				continue
			}
			if bound, ok := parsePartnerBoundTime(candidate.raw, candidate.end); ok && bound.After(now) {
				if wait := bound.Sub(now) + time.Second; wait < delay {
					delay = max(5*time.Second, wait)
				}
			}
		}
	}
	return delay
}

// ResolvePartnerKeysURL 从官方精选注册表校验并返回指定合作伙伴的 HTTPS 领 Key / 返佣跳转地址。
func ResolvePartnerKeysURL(ctx context.Context, dataDir, idOrPreset string) (string, error) {
	needle := strings.TrimSpace(idOrPreset)
	if needle == "" {
		return "", fmt.Errorf("未指定合作伙伴标识")
	}
	cachePath := ""
	if strings.TrimSpace(dataDir) != "" {
		cachePath = filepath.Join(dataDir, "plugins", "market-registry-cache.json")
	}
	raw := readCuratedRegistryWithCache(ctx, NpmMirrorRegistry, cachePath)
	if len(raw) == 0 {
		return "", fmt.Errorf("无法读取合作伙伴列表")
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("解析合作伙伴列表失败")
	}
	for _, entry := range payload.Builtins {
		if !isPartnerBuiltinEntry(entry) {
			continue
		}
		presetID := derivePartnerPresetID(entry)
		if strings.TrimSpace(entry.ID) != needle && presetID != needle {
			continue
		}
		if keysURL := sanitizeHTTPSURL(entry.KeysURL); keysURL != "" {
			return keysURL, nil
		}
		if webURL := sanitizeHTTPSURL(entry.WebsiteURL); webURL != "" {
			return webURL, nil
		}
		if homeURL := sanitizeHTTPSURL(entry.Homepage); homeURL != "" {
			return homeURL, nil
		}
	}
	return "", fmt.Errorf("未找到合作伙伴 %q 的有效跳转链接", needle)
}
