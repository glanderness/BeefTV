package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/kernel"
)

func (s *Service) partnerCatalogAt(ctx context.Context, registry string, now time.Time) []PartnerDescriptor {
	return s.partnerCatalogSnapshotAt(ctx, registry, now).Partners
}

func mustJSONForTest(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestCuratedEntryLiveAtDateWindows(t *testing.T) {
	cst := time.FixedZone("CST", 8*3600)
	refTime := time.Date(2026, 11, 19, 12, 0, 0, 0, cst)
	cases := []struct {
		name  string
		now   time.Time
		from  string
		until string
		want  bool
	}{
		{name: "unbounded", now: refTime, from: "", until: "", want: true},
		{name: "active_iso_window", now: refTime, from: "2026-11-03T00:00:00+08:00", until: "2026-12-04T00:00:00+08:00", want: true},
		{name: "future_from", now: refTime, from: "2026-12-01T00:00:00+08:00", until: "2027-01-01T00:00:00+08:00", want: false},
		{name: "expired_until", now: refTime, from: "2026-10-01T00:00:00+08:00", until: "2026-11-01T00:00:00+08:00", want: false},
		{name: "date_only_inclusive_2359_cst", now: time.Date(2026, 12, 4, 23, 59, 59, 0, cst), from: "2026-11-03", until: "2026-12-04", want: true},
		{name: "date_only_expired_next_midnight_cst", now: time.Date(2026, 12, 5, 0, 0, 0, 0, cst), from: "2026-11-03", until: "2026-12-04", want: false},
		{name: "malformed_date_rejected", now: refTime, from: "not-a-date", until: "", want: false},
	}
	for _, tc := range cases {
		if got := curatedEntryLiveAt(tc.from, tc.until, tc.now); got != tc.want {
			t.Fatalf("%s: curatedEntryLiveAt(%q, %q, %s) = %v, want %v", tc.name, tc.from, tc.until, tc.now.Format(time.RFC3339), got, tc.want)
		}
	}
}

func TestPartnerIconSVGAllowlistAndSSRFGuard(t *testing.T) {
	validSamples := []string{
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g1"><stop offset="0%" stop-color="#005CD2"/></linearGradient></defs><circle cx="12" cy="12" r="10" fill="url(#g1)"/></svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024"><defs><linearGradient id="brand"><stop offset="0%" stop-color="#111"/></linearGradient></defs><path d="M0 0h100v100H0z" fill="URL(#brand)"/><rect width="10" height="10" fill="url( #brand )"/></svg>`,
	}
	for _, sample := range validSamples {
		if !validSanitizedPartnerSVG([]byte(sample)) {
			t.Fatalf("expected clean vector SVG to pass allowlist: %s", sample)
		}
	}
	maliciousSamples := []struct {
		name string
		svg  string
	}{
		{name: "onclick_event", svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" onclick="alert(1)"/></svg>`},
		{name: "onbegin_smil", svg: `<svg xmlns="http://www.w3.org/2000/svg"><animate onbegin="alert(1)"/></svg>`},
		{name: "script_newline", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"><script\n>evil()</script></svg>"},
		{name: "entity_encoded_javascript", svg: `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6a;avascript:alert(1)"><circle r="5"/></a></svg>`},
		{name: "xlink_href_attribute", svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect xlink:href="https://evil.example/a"/></svg>`},
		{name: "foreign_object", svg: `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>`},
		{name: "external_url_fill", svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/x.svg#a)"/></svg>`},
		{name: "protocol_relative_url_fill", svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(//evil.example/x.svg#a)"/></svg>`},
		{name: "spaced_external_url_fill", svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url (//evil.example/x.svg#a)"/></svg>`},
		{name: "xml_entity_directive", svg: `<!DOCTYPE svg [<!ENTITY xxe "evil">]><svg xmlns="http://www.w3.org/2000/svg"><title>&xxe;</title></svg>`},
	}
	for _, tc := range maliciousSamples {
		if validSanitizedPartnerSVG([]byte(tc.svg)) {
			t.Fatalf("%s: expected unsafe SVG to be rejected", tc.name)
		}
	}

	prevLoopback := allowLoopbackMarketURLsForTest
	allowLoopbackMarketURLsForTest = false
	defer func() { allowLoopbackMarketURLsForTest = prevLoopback }()
	for _, blockedURL := range []string{
		"http://cdn.partner.example/logo.svg",
		"https://127.0.0.1/logo.svg",
		"https://10.0.0.8/logo.svg",
		"https://192.168.1.1/logo.svg",
		"https://100.64.0.1/logo.svg",
		"https://169.254.169.254/latest/meta-data",
	} {
		if _, _, err := validatePartnerIconURL(context.Background(), blockedURL); err == nil {
			t.Fatalf("expected non-public or non-HTTPS icon URL %q to be rejected", blockedURL)
		}
	}
}

func TestDynamicPartnerHotOnboardingPersistenceExpirationAndSecurity(t *testing.T) {
	makeAcmeTarball := func(version string) ([]byte, string) {
		return buildTarballBytesForTest(t, map[string]string{
			"package.json": `{
				"name": "beeftv-plugin-acme",
				"version": "` + version + `",
				"description": "Acme dynamic partner ` + version + `",
				"beeftv": {
					"name": "Acme Cloud",
					"client": "./client/index.js",
					"permissions": ["generation.run", "media.read", "ui.slot", "settings.write"],
					"configuration": { "fields": [{ "name": "apiKey", "type": "secret", "label": "Acme Key", "required": true }] },
					"contributes": {
						"providers": [{
							"id": "acme-video",
							"label": "Acme Video",
							"capabilities": ["video"],
							"scopes": ["user.custom-channel", "canvas"],
							"baseUrl": "https://api.acme.example",
							"auth": { "type": "bearer", "field": "apiKey" },
							"create": { "method": "POST", "path": "/v1/videos", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
							"poll": { "method": "GET", "path": "/v1/videos/{{taskId}}", "originPath": true },
							"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
						}]
					}
				}
			}`,
			"client/index.js": "export const VERSION = '" + version + "';\n",
		})
	}

	v100Bytes, v100SHA := makeAcmeTarball("1.0.0")
	v110Bytes, v110SHA := makeAcmeTarball("1.1.0")
	v120Bytes, v120SHA := makeAcmeTarball("1.2.0")
	v120HotfixBytes, v120HotfixSHA := buildTarballBytesForTest(t, map[string]string{
		"package.json": `{
			"name": "beeftv-plugin-acme",
			"version": "1.2.0",
			"description": "Acme dynamic partner 1.2.0 hotfix",
			"beeftv": {
				"name": "Acme Cloud",
				"client": "./client/index.js",
				"permissions": ["generation.run", "media.read", "ui.slot", "settings.write"],
				"configuration": { "fields": [{ "name": "apiKey", "type": "secret", "label": "Acme Key", "required": true }] },
				"contributes": {
					"providers": [{
						"id": "acme-video",
						"label": "Acme Video",
						"capabilities": ["video"],
						"scopes": ["user.custom-channel", "canvas"],
						"baseUrl": "https://api.acme.example",
						"auth": { "type": "bearer", "field": "apiKey" },
						"create": { "method": "POST", "path": "/v1/videos", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
						"poll": { "method": "GET", "path": "/v1/videos/{{taskId}}", "originPath": true },
						"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
					}]
				}
			}
		}`,
		"client/index.js": "export const VERSION = '1.2.0-hotfix';\n",
	})
	wrongIDBytes, wrongIDSHA := buildTarballBytesForTest(t, map[string]string{
		"package.json": `{
			"name": "beeftv-plugin-impostor",
			"version": "1.0.0",
			"description": "mismatched manifest id",
			"beeftv": { "name": "Impostor", "client": "./client/index.js", "permissions": [] }
		}`,
		"client/index.js": "export const X = 1;\n",
	})

	cleanSVG := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>`
	cleanSVGV2 := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="20" height="20"/></svg>`
	mutableSVG := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="6" cy="6" r="4"/></svg>`
	evilSVG := `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>evil()</script></svg>`

	iconHits := 0
	missingIconHits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/acme-1.0.0.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(v100Bytes)
		case "/acme-1.1.0.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(v110Bytes)
		case "/acme-1.2.0.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(v120Bytes)
		case "/acme-1.2.0-hotfix.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(v120HotfixBytes)
		case "/impostor-1.0.0.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(wrongIDBytes)
		case "/acme.svg":
			iconHits++
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(cleanSVG))
		case "/acme-v2.svg":
			iconHits++
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(cleanSVGV2))
		case "/mutable.svg":
			iconHits++
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(mutableSVG))
		case "/missing-404.svg":
			missingIconHits++
			http.NotFound(w, r)
		case "/evil.svg":
			iconHits++
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(evilSVG))
		default:
			http.NotFound(w, r)
		}
	}))
	prevLoopback := allowLoopbackMarketURLsForTest
	allowLoopbackMarketURLsForTest = true
	t.Cleanup(func() {
		server.Close()
		allowLoopbackMarketURLsForTest = prevLoopback
		setCuratedRegistryForTest("")
		capability.BuiltinRegistry().ResetPluginDescriptors()
	})

	refs := &stubReferenceSource{usage: map[string]ReferenceUsage{}}
	dataDir := t.TempDir()
	_, repoFile, _, _ := goruntime.Caller(0)
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(repoFile), "..", "..", ".."))
	prevExec := runtimeExecutable
	runtimeExecutable = func() (string, error) {
		return filepath.Join(repoRoot, "backend", "beeftv"), nil
	}
	t.Cleanup(func() { runtimeExecutable = prevExec })

	rt, err := newRuntime(dataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	tarballFetcher := func(_ context.Context, spec, _, prefixDir string) (string, error) {
		unpacked, unpackErr := unpackTarballToDir(spec, prefixDir)
		if unpackErr != nil {
			return "", unpackErr
		}
		target := filepath.Join(prefixDir, "node_modules", "beeftv-plugin-acme")
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return "", err
		}
		if err := os.Rename(unpacked, target); err != nil {
			return "", err
		}
		return target, nil
	}
	svc.SetPackageFetcher(tarballFetcher)

	setRegistryWithUpdatedAt := func(updatedAt, version, tarballName, sha, until, iconPath string) {
		reg, err := json.Marshal(map[string]any{
			"updatedAt": updatedAt,
			"plugins":   []any{},
			"builtins": []map[string]any{{
				"id":          "beeftv-plugin-acme",
				"packageName": "beeftv-plugin-acme",
				"name":        "Acme Cloud",
				"version":     version,
				"category":    "channel",
				"partner":     true,
				"presetId":    "acme",
				"from":        "2026-01-01T00:00:00+08:00",
				"until":       until,
				"keysUrl":     server.URL + "/register?ref=beeftv",
				"websiteUrl":  server.URL + "/",
				"iconUrl":     server.URL + iconPath,
				"promoText":   "新用户注册赠送体验金",
				"tarball":     server.URL + "/" + tarballName,
				"sha256":      sha,
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		setCuratedRegistryForTest(string(reg))
	}
	setRegistry := func(version, tarballName, sha, until, iconPath string) {
		setRegistryWithUpdatedAt("2026-11-19", version, tarballName, sha, until, iconPath)
	}

	// 1. 阻断本地未校验压缩包抢占官方合作伙伴 ID；阻断 tarball 内部清单 ID 与注册表条目 ID 不一致的提权包；阻断嵌脚本 SVG 图标且安装失败写入 InstallError。
	setRegistry("1.0.0", "impostor-1.0.0.tgz", wrongIDSHA, "2030-01-01T00:00:00+08:00", "/evil.svg")
	if _, squatErr := svc.InstallPackageArchive(v100Bytes, ""); squatErr == nil {
		t.Fatal("expected local archive squat of curated builtin ID to be rejected")
	} else {
		var appErr *kernel.AppError
		if !errors.As(squatErr, &appErr) || appErr.Reason != "plugin_id_reserved" {
			t.Fatalf("unexpected squat error: %v", squatErr)
		}
	}
	// GET PartnerCatalog 必须纯只读：未同步前不发起图标网络请求（iconHits==0）且标记 IconPending=true。
	readOnlyCatalog := svc.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	if iconHits != 0 || len(readOnlyCatalog) != 1 || !readOnlyCatalog[0].IconPending || readOnlyCatalog[0].Installed {
		t.Fatalf("expected PartnerCatalog to stay pure read-only before sync, iconHits=%d catalog=%#v", iconHits, readOnlyCatalog)
	}
	syncErrs := svc.InstallMissingLiveBuiltins(context.Background(), "")
	if syncErrs["beeftv-plugin-acme"] == "" {
		t.Fatalf("expected mismatched manifest ID inside tarball to fail and surface error, got %#v", syncErrs)
	}
	if _, leaked := ByID(svc.List(), "beeftv-plugin-impostor"); leaked {
		t.Fatal("mismatched manifest ID tarball must never be committed as OriginOfficial")
	}
	evilCatalog := svc.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	if len(evilCatalog) != 1 || evilCatalog[0].IconURL != "" || evilCatalog[0].InstallError == "" {
		t.Fatalf("expected script-bearing SVG icon to be rejected and InstallError exposed, got %#v", evilCatalog)
	}

	// 2. 在期新赞助商无需发版自动预装为 OriginOfficial (Trusted=true)，缓存合法 SVG 图标并清空 InstallError。
	setRegistry("1.0.0", "acme-1.0.0.tgz", v100SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	if okErrs := svc.InstallMissingLiveBuiltins(context.Background(), ""); len(okErrs) != 0 {
		t.Fatalf("unexpected install errors: %#v", okErrs)
	}
	catalog := svc.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	if len(catalog) != 1 || !catalog[0].Live || !catalog[0].Installed || !catalog[0].Enabled || catalog[0].InstallError != "" || !strings.HasPrefix(catalog[0].IconURL, "/api/plugins/partners/beeftv-plugin-acme/icon?v=") {
		t.Fatalf("unexpected partner catalog after onboarding: %#v", catalog)
	}
	vHashA := strings.TrimPrefix(catalog[0].IconURL, "/api/plugins/partners/beeftv-plugin-acme/icon?v=")
	iconFile, iconMime, err := svc.ResolvePartnerIconFile("beeftv-plugin-acme", vHashA)
	if err != nil || iconMime != "image/svg+xml" {
		t.Fatalf("ResolvePartnerIconFile(vHashA) = (%q, %q, %v)", iconFile, iconMime, err)
	}
	if iconRaw, readErr := os.ReadFile(iconFile); readErr != nil || !strings.Contains(string(iconRaw), "<circle") {
		t.Fatalf("cached icon content mismatch: %v", readErr)
	}
	// 缓存第二个更新的图标 B 后再把注册表回退到图标 A：ResolvePartnerIconFile 必须按 ?v= 返回 A 而不是较新 mtime 的 B。
	time.Sleep(15 * time.Millisecond)
	setRegistry("1.0.0", "acme-1.0.0.tgz", v100SHA, "2030-01-01T00:00:00+08:00", "/acme-v2.svg")
	_ = svc.InstallMissingLiveBuiltins(context.Background(), "")
	catalogV2 := svc.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	vHashB := strings.TrimPrefix(catalogV2[0].IconURL, "/api/plugins/partners/beeftv-plugin-acme/icon?v=")
	if vHashB == "" || vHashB == vHashA {
		t.Fatalf("expected distinct icon hash for v2 icon, vHashA=%q vHashB=%q", vHashA, vHashB)
	}
	setRegistry("1.0.0", "acme-1.0.0.tgz", v100SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	_ = svc.InstallMissingLiveBuiltins(context.Background(), "")
	revertedCatalog := svc.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	if revertedCatalog[0].IconURL != "/api/plugins/partners/beeftv-plugin-acme/icon?v="+vHashA {
		t.Fatalf("expected reverted catalog icon URL to reference hash A, got %q", revertedCatalog[0].IconURL)
	}
	revertedFile, _, err := svc.ResolvePartnerIconFile("beeftv-plugin-acme", vHashA)
	if err != nil {
		t.Fatalf("ResolvePartnerIconFile(reverted vHashA) err=%v", err)
	}
	if revertedRaw, readErr := os.ReadFile(revertedFile); readErr != nil || !strings.Contains(string(revertedRaw), "<circle") {
		t.Fatalf("expected reverted ?v=hashA to serve icon A (<circle), got %q err=%v", string(revertedRaw), readErr)
	}
	if _, _, staleErr := svc.ResolvePartnerIconFile("beeftv-plugin-acme", "00000000000000000000000000000000"); staleErr == nil {
		t.Fatal("expected unknown ?v= icon hash to return 404")
	}
	keysURL, err := ResolvePartnerKeysURL(context.Background(), dataDir, "acme")
	if err != nil || keysURL != server.URL+"/register?ref=beeftv" {
		t.Fatalf("ResolvePartnerKeysURL(acme) = %q, err=%v", keysURL, err)
	}
	acmeView, ok := ByID(svc.List(), "beeftv-plugin-acme")
	if !ok || acmeView.Source != OriginOfficial || !acmeView.Manifest.Trusted || acmeView.Status != StatusEnabled {
		t.Fatalf("unexpected installed dynamic partner view: %#v (ok=%v)", acmeView, ok)
	}

	// 3. 重启客户端 Runtime：动态预装的合作伙伴插件保留在内置列表中，不被当成废弃内置插件清理。
	rt2, err := newRuntime(dataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	svc2 := New(rt2, nil)
	svc2.SetPackageFetcher(tarballFetcher)
	afterBoot, ok := ByID(svc2.List(), "beeftv-plugin-acme")
	if !ok || afterBoot.Source != OriginOfficial || afterBoot.Status != StatusEnabled || afterBoot.Manifest.Version != "1.0.0" {
		t.Fatalf("dynamic partner did not survive restart cleanly: %#v (ok=%v)", afterBoot, ok)
	}
	if _, resolved := svc2.Registry().Resolve("acme-video"); !resolved {
		t.Fatal("expected acme-video provider active in registry after restart")
	}

	// 4. 在线升级动态赞助商 1.0.0 -> 1.1.0，并保留前一版 @rev-<sha> 相对模块。
	v100Rev := afterBoot.Manifest.Revision
	setRegistry("1.1.0", "acme-1.1.0.tgz", v110SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	updates := svc2.CheckUpdates(context.Background(), "")
	foundUpdate := false
	for _, u := range updates.Updates {
		if u.ID == "beeftv-plugin-acme" && u.Latest == "1.1.0" && u.Official {
			foundUpdate = true
		}
	}
	if !foundUpdate {
		t.Fatalf("expected CheckUpdates to report official update for beeftv-plugin-acme, got %#v", updates)
	}
	upgraded, err := svc2.UpdatePackage("beeftv-plugin-acme", "")
	if err != nil || upgraded.Manifest.Version != "1.1.0" {
		t.Fatalf("UpdatePackage(beeftv-plugin-acme) = %#v, err=%v", upgraded, err)
	}
	if _, _, revErr := svc2.ResolvePackageFile("beeftv-plugin-acme", "/@rev-"+v100Rev+"/client/index.js"); revErr != nil {
		t.Fatalf("expected previous revision %s to remain resolvable right after update: %v", v100Rev, revErr)
	}

	// 5. 赞助到期（now >= until）：新渠道列表 Live=false 下架，但老用户已安装的协议继续可用。
	expiredCatalog := svc2.partnerCatalogAt(context.Background(), "", time.Date(2031, 1, 2, 0, 0, 0, 0, time.UTC))
	if len(expiredCatalog) != 1 || expiredCatalog[0].Live || !expiredCatalog[0].Installed || !expiredCatalog[0].Enabled {
		t.Fatalf("expected expired partner to have Live=false while Installed=true & Enabled=true, got %#v", expiredCatalog)
	}

	// 6. 当官方 builtins 条目被删除、注册表不可读或缺少有效 tarball/SHA-256 时，严禁回退到同名 npm 包提权。
	npmFallbackCalled := false
	svc2.SetPackageFetcher(func(_ context.Context, spec, _, prefixDir string) (string, error) {
		if !strings.HasSuffix(spec, ".downloaded-plugin.tgz") {
			npmFallbackCalled = true
		}
		return tarballFetcher(context.Background(), spec, "", prefixDir)
	})
	for _, badReg := range []string{
		`{"plugins":[]}`,
		`{"plugins":[],"builtins":[]}`,
		`{"plugins":[],"builtins":[{"id":"beeftv-plugin-acme","packageName":"beeftv-plugin-acme","version":"9.9.9"}]}`,
	} {
		setCuratedRegistryForTest(badReg)
		if _, fallbackErr := svc2.UpdatePackage("beeftv-plugin-acme", ""); fallbackErr == nil {
			t.Fatalf("expected UpdatePackage to fail closed without curated SHA-256 tarball for registry=%s", badReg)
		}
		if npmFallbackCalled {
			t.Fatalf("UpdatePackage fell back to unverified npm spec for registry=%s", badReg)
		}
	}
	svc2.SetPackageFetcher(tarballFetcher)
	setRegistry("1.1.0", "acme-1.1.0.tgz", v110SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")

	// 7. activate 阶段客户端 UI 异常不会删除包或停用声明式后端 HTTP 协议（老用户生成不断流）。
	activateErrView, err := svc2.SetLoadErrorAtRevision("beeftv-plugin-acme", "TypeError: slot render error", "activate", upgraded.Manifest.Revision)
	if err != nil || activateErrView.Status != StatusInvalid {
		t.Fatalf("expected activate error to mark client view invalid, got %#v err=%v", activateErrView, err)
	}
	if _, resolved := svc2.Registry().Resolve("acme-video"); !resolved {
		t.Fatal("expected declarative acme-video backend provider to stay registered despite client activate error")
	}

	// 8. import 阶段确定性模块语法错误仅标记客户端视图 StatusInvalid，保持声明式后端协议 acme-video 可用，重启后不循环重拉，发布 1.2.0 后自动恢复。
	quarantined, err := svc2.SetLoadErrorAtRevision("beeftv-plugin-acme", "SyntaxError: broken bundle", "import", upgraded.Manifest.Revision)
	if err != nil || quarantined.Status != StatusInvalid {
		t.Fatalf("expected permanent import load error to mark view invalid, view=%#v err=%v", quarantined, err)
	}
	if _, resolved := svc2.Registry().Resolve("acme-video"); !resolved {
		t.Fatal("expected declarative acme-video provider to remain registered after client import SyntaxError")
	}
	rt3, err := newRuntime(dataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	svc3 := New(rt3, nil)
	svc3.SetPackageFetcher(tarballFetcher)
	quarantinedAfterBoot, ok := ByID(svc3.List(), "beeftv-plugin-acme")
	if !ok || quarantinedAfterBoot.Status != StatusInvalid || quarantinedAfterBoot.Manifest.Version != "1.1.0" {
		t.Fatalf("expected client-invalid dynamic partner to persist across restart, got %#v (ok=%v)", quarantinedAfterBoot, ok)
	}
	if _, resolved := svc3.Registry().Resolve("acme-video"); !resolved {
		t.Fatal("expected declarative acme-video provider to remain registered after restart despite client import SyntaxError")
	}
	setRegistry("1.2.0", "acme-1.2.0.tgz", v120SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	recovered, err := svc3.UpdatePackage("beeftv-plugin-acme", "")
	if err != nil || recovered.Status != StatusEnabled || recovered.Manifest.Version != "1.2.0" {
		t.Fatalf("expected 1.2.0 update to recover dynamic partner, got %#v err=%v", recovered, err)
	}

	// 9. 同一图标 URL 替换内容且注册表 updatedAt 更新时，内容哈希 ?v= 自动刷新；404 图标写入失败退避，避免每次检查无限重试。
	setRegistryWithUpdatedAt("2026-11-20", "1.2.0", "acme-1.2.0.tgz", v120SHA, "2030-01-01T00:00:00+08:00", "/mutable.svg")
	_ = svc3.InstallMissingLiveBuiltins(context.Background(), "")
	mutHash1 := strings.TrimPrefix(svc3.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC))[0].IconURL, "/api/plugins/partners/beeftv-plugin-acme/icon?v=")
	mutableSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="0,0 20,0 10,20"/></svg>`
	setRegistryWithUpdatedAt("2026-11-21", "1.2.0", "acme-1.2.0.tgz", v120SHA, "2030-01-01T00:00:00+08:00", "/mutable.svg")
	_ = svc3.InstallMissingLiveBuiltins(context.Background(), "")
	mutHash2 := strings.TrimPrefix(svc3.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 21, 1, 0, 0, 0, time.UTC))[0].IconURL, "/api/plugins/partners/beeftv-plugin-acme/icon?v=")
	if mutHash1 == "" || mutHash2 == "" || mutHash1 == mutHash2 {
		t.Fatalf("expected same-URL changed SVG bytes to produce new content hash on registry update, mutHash1=%q mutHash2=%q", mutHash1, mutHash2)
	}
	mutFile, _, err := svc3.ResolvePartnerIconFile("beeftv-plugin-acme", mutHash2)
	if err != nil {
		t.Fatalf("ResolvePartnerIconFile(mutHash2) err=%v", err)
	}
	if mutRaw, readErr := os.ReadFile(mutFile); readErr != nil || !strings.Contains(string(mutRaw), "<polygon") {
		t.Fatalf("expected updated icon bytes (<polygon), got %q err=%v", string(mutRaw), readErr)
	}
	setRegistryWithUpdatedAt("2026-11-22", "1.2.0", "acme-1.2.0.tgz", v120SHA, "2030-01-01T00:00:00+08:00", "/missing-404.svg")
	_ = svc3.InstallMissingLiveBuiltins(context.Background(), "")
	hitsAfterFirst404 := missingIconHits
	after404Catalog := svc3.partnerCatalogAt(context.Background(), "", time.Now())
	if hitsAfterFirst404 != 1 || after404Catalog[0].IconPending {
		t.Fatalf("expected 404 icon to record backoff (IconPending=false), hits=%d catalog=%#v", hitsAfterFirst404, after404Catalog)
	}
	_ = svc3.InstallMissingLiveBuiltins(context.Background(), "")
	if missingIconHits != hitsAfterFirst404 {
		t.Fatalf("expected backed-off 404 icon not to refetch immediately, hits=%d", missingIconHits)
	}

	// 10. 本地 .builtin-blobs 被删除或损坏时：ResolvePackageFile 返回 plugin_package_quarantined，重启后声明式协议不断流且 PartnerCatalog 标记 Installed=false，同步后同版本自动重装修复。
	setRegistryWithUpdatedAt("2026-11-23", "1.2.0", "acme-1.2.0.tgz", v120SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	if blobParent, ok := builtinBlobParentDir(dataDir, "beeftv-plugin-acme"); ok {
		removeReadOnlyTree(blobParent)
	}
	if _, _, tamperErr := svc3.ResolvePackageFile("beeftv-plugin-acme", "/client/index.js"); tamperErr == nil {
		t.Fatal("expected ResolvePackageFile on missing dynamic blob to fail")
	} else {
		var appErr *kernel.AppError
		if !errors.As(tamperErr, &appErr) || appErr.Reason != "plugin_package_quarantined" {
			t.Fatalf("expected plugin_package_quarantined reason, got %v", tamperErr)
		}
	}
	rt4, err := newRuntime(dataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	svc4 := New(rt4, nil)
	svc4.SetPackageFetcher(tarballFetcher)
	if _, resolved := svc4.Registry().Resolve("acme-video"); !resolved {
		t.Fatal("expected declarative acme-video provider to remain available on boot even when blob dir was deleted")
	}
	missingBlobCatalog := svc4.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 23, 1, 0, 0, 0, time.UTC))
	if len(missingBlobCatalog) != 1 || missingBlobCatalog[0].Installed {
		t.Fatalf("expected missing blob dynamic partner to report Installed=false before repair, got %#v", missingBlobCatalog)
	}
	if repairErrs := svc4.InstallMissingLiveBuiltins(context.Background(), ""); len(repairErrs) != 0 {
		t.Fatalf("expected missing blob repair to succeed at same version 1.2.0, got %#v", repairErrs)
	}
	repairedView, ok := ByID(svc4.List(), "beeftv-plugin-acme")
	if !ok || repairedView.Status != StatusEnabled || repairedView.Manifest.Version != "1.2.0" {
		t.Fatalf("expected repaired dynamic partner to return to StatusEnabled at 1.2.0, got %#v (ok=%v)", repairedView, ok)
	}
	// 当旧 1.2.0 包目录完好但注册表重新发布了同版本不同 SHA 热修包时，30 分钟同步路径立即更新到新 SHA。
	setRegistryWithUpdatedAt("2026-11-24", "1.2.0", "acme-1.2.0-hotfix.tgz", v120HotfixSHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	if hotfixPre := svc4.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 24, 1, 0, 0, 0, time.UTC)); len(hotfixPre) != 1 || hotfixPre[0].Installed {
		t.Fatalf("expected same-version SHA replacement to mark Installed=false before sync, got %#v", hotfixPre)
	}
	if hotfixErrs := svc4.InstallMissingLiveBuiltins(context.Background(), ""); len(hotfixErrs) != 0 {
		t.Fatalf("expected same-version SHA replacement sync to succeed, got %#v", hotfixErrs)
	}
	hotfixedView, ok := ByID(svc4.List(), "beeftv-plugin-acme")
	if !ok || !strings.EqualFold(hotfixedView.ArchiveSHA256, v120HotfixSHA) {
		t.Fatalf("expected dynamic partner ArchiveSHA256 to update to %s, got %#v", v120HotfixSHA, hotfixedView)
	}
	// 当该伙伴合作窗口已过期且 .builtin-blobs 缺失时，同步路径仍会修复已安装老伙伴的包目录，但不会新装从未安装过的已过期伙伴。
	setCuratedRegistryForTest(string(mustJSONForTest(t, map[string]any{
		"updatedAt": "2026-11-25",
		"plugins":   []any{},
		"builtins": []map[string]any{
			{
				"id":          "beeftv-plugin-acme",
				"packageName": "beeftv-plugin-acme",
				"name":        "Acme Cloud",
				"version":     "1.2.0",
				"category":    "channel",
				"partner":     true,
				"presetId":    "acme-explicit",
				"from":        "2026-01-01T00:00:00+08:00",
				"until":       "2026-10-01T00:00:00+08:00",
				"tarball":     server.URL + "/acme-1.2.0-hotfix.tgz",
				"sha256":      v120HotfixSHA,
			},
			{
				"id":          "beeftv-plugin-never",
				"packageName": "beeftv-plugin-never",
				"name":        "Expired Never Installed",
				"version":     "1.0.0",
				"category":    "channel",
				"partner":     true,
				"presetId":    "never",
				"from":        "2026-01-01T00:00:00+08:00",
				"until":       "2026-10-01T00:00:00+08:00",
				"tarball":     server.URL + "/acme-1.0.0.tgz",
				"sha256":      v100SHA,
			},
		},
	})))
	if blobParent, ok := builtinBlobParentDir(dataDir, "beeftv-plugin-acme"); ok {
		removeReadOnlyTree(blobParent)
	}
	expiredMissingCat := svc4.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 25, 1, 0, 0, 0, time.UTC))
	if len(expiredMissingCat) != 2 || expiredMissingCat[0].Live || expiredMissingCat[0].Installed || !expiredMissingCat[0].RepairNeeded {
		t.Fatalf("expected expired partner with missing blob to report Installed=false & RepairNeeded=true, got %#v", expiredMissingCat)
	}
	if expRepairErrs := svc4.InstallMissingLiveBuiltins(context.Background(), ""); len(expRepairErrs) != 0 {
		t.Fatalf("expected expired installed partner missing-blob repair to succeed, got %#v", expRepairErrs)
	}
	if _, neverInstalled := ByID(svc4.List(), "beeftv-plugin-never"); neverInstalled {
		t.Fatal("expired partner that was never installed must not be newly installed")
	}
	expRepairedView, ok := ByID(svc4.List(), "beeftv-plugin-acme")
	if !ok || expRepairedView.PartnerPresetID != "acme-explicit" || expRepairedView.Status != StatusEnabled {
		t.Fatalf("expected repaired expired partner to persist explicit PartnerPresetID=acme-explicit, got %#v", expRepairedView)
	}
	// 重启后从远端 registry.json 完全移除（Complete=true）：仍返回持久化的 PresetID="acme-explicit" 与 Retired=true；离线降级（Complete=false）则不发合成退役项。
	rt5, err := newRuntime(dataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	svc5 := New(rt5, nil)
	setCuratedRegistryForTest(`{"updatedAt":"2026-11-26","plugins":[],"builtins":[]}`)
	retiredSnap := svc5.partnerCatalogSnapshotAt(context.Background(), "", time.Date(2026, 11, 26, 1, 0, 0, 0, time.UTC))
	if !retiredSnap.Complete || len(retiredSnap.Partners) != 1 || !retiredSnap.Partners[0].Retired || retiredSnap.Partners[0].PresetID != "acme-explicit" || retiredSnap.Partners[0].Live || !retiredSnap.Partners[0].Installed {
		t.Fatalf("expected Complete=true removal to emit Retired=true with persisted PresetID=acme-explicit, got %#v", retiredSnap)
	}
	setCuratedRegistryForTest("")
	offlineCtx, cancelOffline := context.WithCancel(context.Background())
	cancelOffline()
	offlineSnap := svc5.partnerCatalogSnapshotAt(offlineCtx, "", time.Date(2026, 11, 26, 1, 0, 0, 0, time.UTC))
	if offlineSnap.Complete {
		t.Fatalf("expected cancelled/offline catalog snapshot to have Complete=false, got %#v", offlineSnap)
	}
	for _, p := range offlineSnap.Partners {
		if p.ID == "beeftv-plugin-acme" {
			t.Fatalf("expected Complete=false fallback not to emit synthetic Retired=true descriptor for beeftv-plugin-acme, got %#v", p)
		}
	}

	// 11. 用户在官方注册表新增前已装过同名本地非官方包（OriginPackage）：即使此前存有历史瞬时错误，冲突优先级最高（InstallErrorKind=conflict），不静默认作已装也不覆盖用户包。
	conflictDataDir := t.TempDir()
	setCuratedRegistryForTest(`{"plugins":[],"builtins":[]}`)
	conflictRT, err := newRuntime(conflictDataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	conflictSvc := New(conflictRT, nil)
	conflictSvc.SetPackageFetcher(tarballFetcher)
	setPartnerInstallError(conflictSvc, "beeftv-plugin-acme", "stale transient network timeout", "transient")
	localView, err := conflictSvc.InstallPackageArchive(v100Bytes, "")
	if err != nil || localView.Source != OriginPackage {
		t.Fatalf("expected pre-registry local archive install to succeed as OriginPackage, got %#v err=%v", localView, err)
	}
	setRegistry("1.2.0", "acme-1.2.0.tgz", v120SHA, "2030-01-01T00:00:00+08:00", "/acme.svg")
	beforeSyncConflict := conflictSvc.partnerCatalogAt(context.Background(), "", time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	if len(beforeSyncConflict) != 1 || beforeSyncConflict[0].Installed || beforeSyncConflict[0].InstallErrorKind != "conflict" || !strings.Contains(beforeSyncConflict[0].InstallError, "同名非官方插件") {
		t.Fatalf("expected PartnerCatalog to prioritize conflict InstallErrorKind over stale transient error, got %#v", beforeSyncConflict)
	}
	conflictErrs := conflictSvc.InstallMissingLiveBuiltins(context.Background(), "")
	if !strings.Contains(conflictErrs["beeftv-plugin-acme"], "同名非官方插件") {
		t.Fatalf("expected InstallMissingLiveBuiltins to return conflict error, got %#v", conflictErrs)
	}
}

func TestCuratedRegistryFreshnessNeverLetsUndatedCacheOutrankBundled(t *testing.T) {
	_, repoFile, _, _ := goruntime.Caller(0)
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(repoFile), "..", "..", ".."))
	prevExec := runtimeExecutable
	runtimeExecutable = func() (string, error) {
		return filepath.Join(repoRoot, "backend", "beeftv"), nil
	}
	t.Cleanup(func() { runtimeExecutable = prevExec })

	cacheFile := filepath.Join(t.TempDir(), "market-registry-cache.json")
	if err := os.WriteFile(cacheFile, []byte(`{"plugins":[],"builtins":[{"id":"beeftv-plugin-ll2","packageName":"beeftv-plugin-ll2","name":"Old LL2","version":"0.0.1"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	baseline := readLocalCuratedRegistryBaseline(cacheFile)
	if stamp := curatedRegistryUpdatedAt(baseline); stamp == "" {
		t.Fatalf("expected dated bundled registry to outrank undated cache, got baseline=%s", string(baseline))
	}
	var parsed curatedRegistryPayload
	if err := json.Unmarshal(baseline, &parsed); err != nil || len(parsed.Builtins) < 2 {
		t.Fatalf("expected non-empty undated cache to merge missing bundled builtins by ID, err=%v builtins=%#v", err, parsed.Builtins)
	}
	hasYsdui, upgradedLL2 := false, false
	for _, b := range parsed.Builtins {
		if b.ID == "beeftv-plugin-ysdui" {
			hasYsdui = true
		}
		if b.ID == "beeftv-plugin-ll2" && b.Version != "0.0.1" {
			upgradedLL2 = true
		}
	}
	if !hasYsdui || !upgradedLL2 {
		t.Fatalf("expected bundled builtins merged by ID (ysdui=%v upgradedLL2=%v), got %#v", hasYsdui, upgradedLL2, parsed.Builtins)
	}
}
