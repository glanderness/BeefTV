package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/protocol"
)

func TestNewerVersionOnlyComparesPlainNumbers(t *testing.T) {
	for _, tc := range []struct {
		latest, current string
		want            bool
	}{
		{"1.0.10", "1.0.9", true},
		{"0.2.0", "0.1.9", true},
		{"1.0.0", "1.0.0", false},
		{"1.0.0", "1.0.1", false},
		{"v2.0.0", "1.9.9", true},
		{"1.1.0-beta.1", "1.0.0", true},
		{"latest", "1.0.0", false},
		{"", "1.0.0", false},
	} {
		if got := newerVersion(tc.latest, tc.current); got != tc.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

// npmFixture 用本地服务冒充 npm：/<包名>/latest 返回 latest 里登记的版本。
func npmFixture(t *testing.T, latest map[string]string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), "/latest")
		version, ok := latest[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": name, "version": version, "description": name + " 的说明",
			"author": map[string]string{"name": "社区作者"}, "repository": map[string]string{"url": "git+https://github.com/example/" + name + ".git"},
			"beeftv": map[string]string{"name": "显示名 " + name},
		})
	}))
	prevLoopback, prevRegistries := allowLoopbackMarketURLsForTest, npmRegistriesForTest
	allowLoopbackMarketURLsForTest, npmRegistriesForTest = true, []string{server.URL}
	t.Cleanup(func() {
		server.Close()
		allowLoopbackMarketURLsForTest, npmRegistriesForTest = prevLoopback, prevRegistries
		npmSummaryCache.Lock()
		npmSummaryCache.items = map[string]npmSummaryEntry{}
		npmSummaryCache.Unlock()
		setCuratedRegistryForTest("")
	})
}

func setCuratedRegistryForTest(raw string) {
	curatedRegistryMemCache.Lock()
	defer curatedRegistryMemCache.Unlock()
	if raw == "" {
		curatedRegistryMemCache.raw, curatedRegistryMemCache.fetchedAt, curatedRegistryMemCache.pinnedTest = nil, time.Time{}, false
		return
	}
	curatedRegistryMemCache.raw, curatedRegistryMemCache.fetchedAt, curatedRegistryMemCache.pinnedTest = []byte(raw), time.Now(), true
}

// installNamedForTest 按 npm 包名安装，假安装器把包名对到本地目录。
func installNamedForTest(t *testing.T, svc *Service, dirs map[string]string, name, version string) {
	t.Helper()
	dir := t.TempDir()
	writePluginFolder(t, dir, map[string]string{
		"package.json":    `{"name":"` + name + `","version":"` + version + `","beeftv":{"client":"./client/index.js"}}`,
		"client/index.js": "export function activate() {}\n",
	})
	dirs[name] = dir
	if _, err := svc.InstallPackage(name, ""); err != nil {
		t.Fatalf("install %s: %v", name, err)
	}
}

func TestCheckUpdatesListsOnlyPluginsWithANewerVersion(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-behind": "0.2.0", "beeftv-plugin-current": "1.0.0"})
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	dirs := map[string]string{}
	svc.SetPackageFetcher(func(ctx context.Context, spec, registry, prefixDir string) (string, error) {
		if dir, ok := dirs[spec]; ok {
			spec = dir
		}
		return copyPackageFetcher(ctx, spec, registry, prefixDir)
	})
	installNamedForTest(t, svc, dirs, "beeftv-plugin-behind", "0.1.0")
	installNamedForTest(t, svc, dirs, "beeftv-plugin-current", "1.0.0")
	installNamedForTest(t, svc, dirs, "beeftv-plugin-pinned", "1.0.0")
	installNamedForTest(t, svc, dirs, "beeftv-plugin-unpublished", "0.1.0")
	folder := t.TempDir()
	writePluginFolder(t, folder, map[string]string{
		"package.json":    `{"name":"beeftv-plugin-folder","version":"0.0.1","beeftv":{"client":"./client/index.js"}}`,
		"client/index.js": "export function activate() {}\n",
	})
	if _, err := svc.InstallPackage(folder, ""); err != nil {
		t.Fatal(err)
	}
	setCuratedRegistryForTest(`{"plugins":[{"id":"beeftv-plugin-pinned","packageName":"beeftv-plugin-pinned","version":"1.1.0",
		"tarball":"https://github.com/example/releases/pinned-1.1.0.tgz","sha256":"` + strings.Repeat("a", 64) + `"}]}`)

	got := svc.CheckUpdates(context.Background(), "")
	want := []UpdateNotice{
		{ID: "beeftv-plugin-behind", Version: "0.1.0", Latest: "0.2.0"},
		{ID: "beeftv-plugin-pinned", Version: "1.0.0", Latest: "1.1.0", Official: true},
	}
	if len(got.Updates) != len(want) || got.Updates[0] != want[0] || got.Updates[1] != want[1] {
		t.Fatalf("updates = %+v", got.Updates)
	}
	// 文件夹装的和 npm 上查不到的插件没法比较，两份名单都不进，界面照旧给「更新」按钮。
	if strings.Join(got.UpToDate, ",") != "beeftv-plugin-current" {
		t.Fatalf("up to date = %v", got.UpToDate)
	}
}

func TestOneLineRegistryEntriesAreFilledFromNpm(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-community": "0.3.0"})
	setCuratedRegistryForTest(`{"plugins":[],"packages":["beeftv-plugin-community","beeftv-plugin-missing",""]}`)
	cachePath := filepath.Join(t.TempDir(), "cache.json")
	items := loadCuratedRegistryItemsWithCache(context.Background(), "", NpmMirrorRegistry, cachePath, map[string]View{})
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	item := items[0]
	if item.ID != "beeftv-plugin-community" || item.Name != "显示名 beeftv-plugin-community" || item.Version != "0.3.0" ||
		item.Author != "社区作者" || item.Repository != "https://github.com/example/beeftv-plugin-community" || !item.Recommended || item.SHA256 != "" {
		t.Fatalf("item = %+v", item)
	}
	if hits := loadCuratedRegistryItemsWithCache(context.Background(), "nothing-matches", NpmMirrorRegistry, cachePath, map[string]View{}); len(hits) != 0 {
		t.Fatalf("query hits = %+v", hits)
	}
}

func TestCuratedMarketReturnsLocalEntriesBeforePackageMetadataRefresh(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-community": "0.3.0"})
	setCuratedRegistryForTest(`{"plugins":[{"id":"cached-plugin","name":"Cached plugin","version":"1.0.0","recommended":true}],"packages":["beeftv-plugin-community"]}`)
	var svc *Service
	cached := svc.CuratedMarket(context.Background(), NpmMirrorRegistry, true)
	if len(cached) != 1 || cached[0].ID != "cached-plugin" {
		t.Fatalf("local recommendations = %+v", cached)
	}
	refreshed := svc.CuratedMarket(context.Background(), NpmMirrorRegistry, false)
	if len(refreshed) != 2 || refreshed[1].ID != "beeftv-plugin-community" {
		t.Fatalf("refreshed recommendations = %+v", refreshed)
	}
}

func TestVersionedInstallUpdatesToLatestByHandOnly(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-held": "0.2.0"})
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	folder := func(version string) string {
		dir := t.TempDir()
		writePluginFolder(t, dir, map[string]string{
			"package.json":    `{"name":"beeftv-plugin-held","version":"` + version + `","beeftv":{"client":"./client/index.js"}}`,
			"client/index.js": "export function activate() {}\n",
		})
		return dir
	}
	dirs := map[string]string{"beeftv-plugin-held@0.1.0": folder("0.1.0"), "beeftv-plugin-held": folder("0.2.0")}
	svc.SetPackageFetcher(func(ctx context.Context, spec, registry, prefixDir string) (string, error) {
		return copyPackageFetcher(ctx, dirs[spec], registry, prefixDir)
	})
	if _, err := svc.InstallPackage("beeftv-plugin-held@0.1.0", ""); err != nil {
		t.Fatal(err)
	}

	// 精选列表有新版本时只提示，不算自动更新。
	setCuratedRegistryForTest(`{"plugins":[{"id":"beeftv-plugin-held","packageName":"beeftv-plugin-held","version":"0.2.0",
		"tarball":"https://github.com/example/releases/held-0.2.0.tgz","sha256":"` + strings.Repeat("a", 64) + `"}]}`)
	got := svc.CheckUpdates(context.Background(), "")
	if len(got.Updates) != 1 || got.Updates[0].Latest != "0.2.0" || got.Updates[0].Official {
		t.Fatalf("updates = %+v", got.Updates)
	}

	setCuratedRegistryForTest(`{"plugins":[]}`)
	updated, err := svc.UpdatePackage("beeftv-plugin-held", "")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Manifest.Version != "0.2.0" || updated.PackageSpec != "beeftv-plugin-held" {
		t.Fatalf("updated = %s from %q", updated.Manifest.Version, updated.PackageSpec)
	}
}

func TestLL2Wan3VideoProviderContract(t *testing.T) {
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatalf("NewRuntime failed: %v", err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)

	adapter, ok := svc.Registry().Resolve("ll2-wan3-video")
	if !ok {
		t.Fatal("expected ll2-wan3-video provider to be registered")
	}

	// 复现群反馈场景：旧节点记录 resolution="480"、不兼容比例 "21:9"、单图未标 role 的图生视频。
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://api.ll2.cn/v1",
		Request: protocol.GenerationRequest{
			Model:       "wan3.0-video",
			Prompt:      "a quiet harbor at blue hour",
			Operation:   "image_to_video",
			Resolution:  "480",
			AspectRatio: "21:9",
			Duration:    1,
			Images:      []protocol.MediaReference{{URL: "https://cdn.example.com/frame.png"}},
		},
	})
	if err != nil {
		t.Fatalf("BuildCreate(ll2-wan3-video) failed: %v", err)
	}
	if spec.Path != "/ali/api/v1/services/aigc/video-generation/video-synthesis" || !spec.OriginPath {
		t.Fatalf("unexpected create path=%q originPath=%v", spec.Path, spec.OriginPath)
	}
	if spec.Headers["X-DashScope-Async"] != "enable" {
		t.Fatalf("expected X-DashScope-Async=enable, got %#v", spec.Headers)
	}
	rawBody, err := json.Marshal(spec.Body)
	if err != nil {
		t.Fatalf("marshal create body: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		t.Fatalf("unmarshal create body: %v", err)
	}
	params, _ := payload["parameters"].(map[string]any)
	if params["resolution"] != "480P" || params["ratio"] != "adaptive" || params["duration"] != float64(2) {
		t.Fatalf("unexpected normalized parameters: %#v", params)
	}
	inputObj, _ := payload["input"].(map[string]any)
	mediaList, _ := inputObj["media"].([]any)
	if len(mediaList) != 1 {
		t.Fatalf("expected 1 media entry, got %#v", mediaList)
	}
	firstMedia, _ := mediaList[0].(map[string]any)
	if firstMedia["type"] != "first_frame" || firstMedia["url"] != "https://cdn.example.com/frame.png" {
		t.Fatalf("unexpected first_frame media mapping: %#v", firstMedia)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"output":{"task_id":"wan3-task-1","task_status":"PENDING"},"request_id":"req-1"}`))
	if err != nil || created.TaskID != "wan3-task-1" {
		t.Fatalf("ParseCreate unexpected: created=%#v err=%v", created, err)
	}
	pollSpec, err := adapter.BuildPoll(context.Background(), protocol.PollContext{BaseURL: "https://api.ll2.cn/v1", TaskID: created.TaskID})
	if err != nil || pollSpec.Path != "/ali/api/v1/tasks/wan3-task-1" || !pollSpec.OriginPath {
		t.Fatalf("BuildPoll unexpected: spec=%#v err=%v", pollSpec, err)
	}
	done, err := adapter.ParsePoll(context.Background(), protocol.PollContext{TaskID: created.TaskID}, []byte(`{"output":{"task_id":"wan3-task-1","task_status":"SUCCEEDED","video_url":"https://cdn.example.com/wan3.mp4"}}`))
	if err != nil || done.Status != protocol.StatusSucceeded || len(done.Result.Videos) != 1 || done.Result.Videos[0].URL != "https://cdn.example.com/wan3.mp4" {
		t.Fatalf("ParsePoll(SUCCEEDED) unexpected: state=%#v err=%v", done, err)
	}
	failed, err := adapter.ParsePoll(context.Background(), protocol.PollContext{TaskID: created.TaskID}, []byte(`{"output":{"task_id":"wan3-task-1","task_status":"FAILED","code":"InvalidParameter","message":"bad resolution"}}`))
	if err != nil || failed.Status != protocol.StatusFailed || failed.Message != "bad resolution" {
		t.Fatalf("ParsePoll(FAILED) unexpected: state=%#v err=%v", failed, err)
	}

	// 全分辨率档位校验：480/720/1080 规范化为大写 P，2K/4K/1440/2160/360p 等不支持档位明确报错，不静默降档。
	resCases := []struct {
		in   string
		want string
	}{
		{"", "720P"},
		{"480", "480P"},
		{"480p", "480P"},
		{"720", "720P"},
		{"720p", "720P"},
		{"1080", "1080P"},
		{"1080p", "1080P"},
	}
	for _, tc := range resCases {
		resSpec, resErr := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://api.ll2.cn",
			Request: protocol.GenerationRequest{
				Model:      "wan3.0-video",
				Operation:  "text_to_video",
				Prompt:     "harbor",
				Resolution: tc.in,
			},
		})
		if resErr != nil {
			t.Fatalf("BuildCreate(resolution=%q) failed: %v", tc.in, resErr)
		}
		resBody, _ := json.Marshal(resSpec.Body)
		var resPayload map[string]any
		_ = json.Unmarshal(resBody, &resPayload)
		resParams, _ := resPayload["parameters"].(map[string]any)
		if resParams["resolution"] != tc.want {
			t.Fatalf("resolution %q mapped to %v, want %q", tc.in, resParams["resolution"], tc.want)
		}
	}
	for _, unsupported := range []string{"360p", "1440p", "2k", "2160p", "4K"} {
		if _, badResErr := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://api.ll2.cn",
			Request: protocol.GenerationRequest{Model: "wan3.0-video", Prompt: "harbor", Resolution: unsupported},
		}); badResErr == nil {
			t.Fatalf("expected unsupported Wan 3.0 resolution %q to fail validation", unsupported)
		}
	}

	// 参考视频编辑/延长强制 parameters.ratio = adaptive。
	videoEditSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://api.ll2.cn",
		Request: protocol.GenerationRequest{
			Model:       "wan3.0-video-prime",
			Operation:   "reference_to_video",
			Prompt:      "continue camera pan",
			AspectRatio: "16:9",
			Resolution:  "1080P",
			Videos:      []protocol.MediaReference{{URL: "https://cdn.example.com/ref.mp4"}},
		},
	})
	if err != nil {
		t.Fatalf("BuildCreate(reference_video) failed: %v", err)
	}
	editRaw, _ := json.Marshal(videoEditSpec.Body)
	var editPayload map[string]any
	_ = json.Unmarshal(editRaw, &editPayload)
	editParams, _ := editPayload["parameters"].(map[string]any)
	if editParams["ratio"] != "adaptive" {
		t.Fatalf("expected reference_video ratio to force adaptive, got %v", editParams["ratio"])
	}

	// 组合冲突校验：空提示词且无素材、只有尾帧无首帧、首帧混参考视频都必须在本地被拦截。
	conflictReqs := []protocol.GenerationRequest{
		{Model: "wan3.0-video", Operation: "text_to_video"},
		{Model: "wan3.0-video", Operation: "image_to_video", Images: []protocol.MediaReference{{URL: "https://cdn.example.com/end.png", Role: "last_frame"}}},
		{
			Model:     "wan3.0-video",
			Operation: "reference_to_video",
			Images:    []protocol.MediaReference{{URL: "https://cdn.example.com/start.png", Role: "first_frame"}},
			Videos:    []protocol.MediaReference{{URL: "https://cdn.example.com/ref.mp4"}},
		},
	}
	for i, badReq := range conflictReqs {
		if _, conflictErr := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://api.ll2.cn",
			Request: badReq,
		}); conflictErr == nil {
			t.Fatalf("expected conflict case #%d (%+v) to fail validation", i, badReq)
		}
	}
}

func TestLL2SuperVegaResolutionContract(t *testing.T) {
	t.Cleanup(func() { capability.BuiltinRegistry().ResetPluginDescriptors() })
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	adapter, ok := svc.Registry().Resolve("ll2-super-vega-video")
	if !ok {
		t.Fatal("expected ll2-super-vega-video provider to be registered")
	}

	models := []string{
		"Super Vega 1.0-lite",
		"Super Vega 1.0-pro-mini",
		"Super Vega 1.0-pro-fast",
		"Super Vega 1.0-pro",
		"Super Vega 1.5-pro",
	}
	tiers := []struct {
		in   string
		want string
	}{
		{"480p", "480P"},
		{"720p", "720P"},
		{"768P", "768P"},
		{"1080p", "1080P"},
		{"2k", "2K"},
		{"4k", "4K"},
	}
	for _, m := range models {
		for _, tier := range tiers {
			spec, buildErr := adapter.BuildCreate(context.Background(), protocol.RequestContext{
				BaseURL: "https://api.ll2.cn",
				Request: protocol.GenerationRequest{Model: m, Prompt: "cat", Resolution: tier.in},
			})
			if buildErr != nil {
				t.Fatalf("Super Vega %s resolution %s failed: %v", m, tier.in, buildErr)
			}
			if spec.Headers["User-Agent"] != "BeefTV" {
				t.Fatalf("expected User-Agent: BeefTV header, got %#v", spec.Headers)
			}
			raw, _ := json.Marshal(spec.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			outCfg, _ := body["OutputConfig"].(map[string]any)
			if outCfg["Resolution"] != tier.want {
				t.Fatalf("Super Vega %s resolution %s mapped to %v, want %s", m, tier.in, outCfg["Resolution"], tier.want)
			}
		}
	}
	// 空分辨率时 1.0-lite 默认 768P，Pro 默认 720P；非法档位直接报错。
	liteSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://api.ll2.cn",
		Request: protocol.GenerationRequest{Model: "Super Vega 1.0-lite", Prompt: "cat"},
	})
	if err != nil {
		t.Fatal(err)
	}
	liteRaw, _ := json.Marshal(liteSpec.Body)
	var liteBody map[string]any
	_ = json.Unmarshal(liteRaw, &liteBody)
	if liteBody["OutputConfig"].(map[string]any)["Resolution"] != "768P" {
		t.Fatalf("expected empty 1.0-lite resolution to default to 768P, got %v", liteBody["OutputConfig"])
	}
	if _, badErr := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://api.ll2.cn",
		Request: protocol.GenerationRequest{Model: "Super Vega 1.5-pro", Prompt: "cat", Resolution: "360p"},
	}); badErr == nil {
		t.Fatal("expected unsupported Super Vega resolution 360p to fail validation")
	}

	// 验证 doubao-seedance-2-5 在首帧、首尾帧、续写(extend)、局部编辑(inpaint) 下强制 ratio=adaptive，编辑强制 duration=-1 且带 omni_reference_task_type。
	seedance, ok := svc.Registry().Resolve("ll2-seedance-video")
	if !ok {
		t.Fatal("expected ll2-seedance-video provider to be registered")
	}
	seedanceCases := []struct {
		name     string
		req      protocol.GenerationRequest
		wantTask string
		wantDur  float64
	}{
		{
			name: "first_frame",
			req: protocol.GenerationRequest{
				Model: "doubao-seedance-2-5", Operation: "image_to_video", Prompt: "zoom", AspectRatio: "16:9", Duration: 5,
				Images: []protocol.MediaReference{{URL: "https://cdn.example.com/start.png", Role: "first_frame"}},
			},
			wantDur: 5,
		},
		{
			name: "first_and_last_frame",
			req: protocol.GenerationRequest{
				Model: "doubao-seedance-2-5", Operation: "image_to_video", Prompt: "pan", AspectRatio: "9:16", Duration: 6,
				Images: []protocol.MediaReference{
					{URL: "https://cdn.example.com/start.png", Role: "first_frame"},
					{URL: "https://cdn.example.com/end.png", Role: "last_frame"},
				},
			},
			wantDur: 6,
		},
		{
			name: "extend",
			req: protocol.GenerationRequest{
				Model: "doubao-seedance-2-5", Operation: "extend", Prompt: "continue", AspectRatio: "16:9", Duration: 8,
				Videos: []protocol.MediaReference{{URL: "https://cdn.example.com/clip.mp4"}},
			},
			wantTask: "extend",
			wantDur:  8,
		},
		{
			name: "inpaint",
			req: protocol.GenerationRequest{
				Model: "doubao-seedance-2-5", Operation: "inpaint", Prompt: "replace hat", AspectRatio: "16:9", Duration: 10,
				Videos: []protocol.MediaReference{{URL: "https://cdn.example.com/clip.mp4"}},
			},
			wantTask: "edit",
			wantDur:  -1,
		},
	}
	for _, sc := range seedanceCases {
		spec, buildErr := seedance.BuildCreate(context.Background(), protocol.RequestContext{BaseURL: "https://api.ll2.cn", Request: sc.req})
		if buildErr != nil {
			t.Fatalf("Seedance 2.5 %s failed: %v", sc.name, buildErr)
		}
		raw, _ := json.Marshal(spec.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		if body["ratio"] != "adaptive" {
			t.Fatalf("Seedance 2.5 %s ratio = %v, want adaptive", sc.name, body["ratio"])
		}
		if body["duration"] != sc.wantDur {
			t.Fatalf("Seedance 2.5 %s duration = %v, want %v", sc.name, body["duration"], sc.wantDur)
		}
		if sc.wantTask != "" && body["omni_reference_task_type"] != sc.wantTask {
			t.Fatalf("Seedance 2.5 %s omni_reference_task_type = %v, want %q", sc.name, body["omni_reference_task_type"], sc.wantTask)
		}
	}
	t2vSpec, err := seedance.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://api.ll2.cn",
		Request: protocol.GenerationRequest{
			Model:       "doubao-seedance-2-5",
			Operation:   "text_to_video",
			Prompt:      "sunset",
			AspectRatio: "16:9",
		},
	})
	if err != nil {
		t.Fatalf("Seedance 2.5 text_to_video failed: %v", err)
	}
	t2vRaw, _ := json.Marshal(t2vSpec.Body)
	var t2vBody map[string]any
	_ = json.Unmarshal(t2vRaw, &t2vBody)
	if t2vBody["ratio"] != "16:9" {
		t.Fatalf("expected Seedance 2.5 text_to_video ratio=16:9, got %v", t2vBody["ratio"])
	}
}

func buildTarballBytesForTest(t *testing.T, files map[string]string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range files {
		hdr := &tar.Header{
			Name: "package/" + name,
			Mode: 0o644,
			Size: int64(len(content)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	sum := sha256.Sum256(raw)
	return raw, hex.EncodeToString(sum[:])
}

func TestCuratedBuiltinPluginHotUpdatesAndPersistsAcrossRestart(t *testing.T) {
	tgzBytes, tgzSHA := buildTarballBytesForTest(t, map[string]string{
		"package.json": `{
			"name": "beeftv-plugin-ll2",
			"version": "9.9.0",
			"description": "hot updated ll2",
			"beeftv": {
				"name": "LL2 算力与视频渠道",
				"client": "./client/index.js",
				"permissions": ["generation.run", "media.read", "ui.slot", "settings.write"],
				"configuration": { "fields": [{ "name": "apiKey", "type": "secret", "label": "Key", "required": true }] },
				"contributes": {
					"providers": [{
						"id": "ll2-future-hot-video",
						"label": "LL2 Future Hot Video",
						"capabilities": ["video"],
						"scopes": ["user.custom-channel", "canvas"],
						"baseUrl": "https://api.ll2.cn",
						"auth": { "type": "bearer", "field": "apiKey" },
						"create": { "method": "POST", "path": "/future/tasks", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
						"poll": { "method": "GET", "path": "/future/tasks/{{taskId}}", "originPath": true },
						"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
					}]
				}
			}
		}`,
		"client/index.js": "export function activate() {}\n",
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/beeftv-plugin-ll2-9.9.0.tgz" {
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(tgzBytes)
			return
		}
		http.NotFound(w, r)
	}))
	prevLoopback := allowLoopbackMarketURLsForTest
	allowLoopbackMarketURLsForTest = true
	t.Cleanup(func() {
		server.Close()
		allowLoopbackMarketURLsForTest = prevLoopback
		setCuratedRegistryForTest("")
		capability.BuiltinRegistry().ResetPluginDescriptors()
	})

	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)

	// 未经官方校验目录的本地目录覆盖必须继续被拒绝。
	forgedDir := t.TempDir()
	writePluginFolder(t, forgedDir, map[string]string{
		"package.json":    `{"name":"beeftv-plugin-ll2","version":"9.9.9","beeftv":{"client":"./client/index.js"}}`,
		"client/index.js": "export function activate() {}\n",
	})
	if _, err := svc.InstallPackage(forgedDir, ""); err == nil {
		t.Fatal("expected unverified local folder overwrite of builtin plugin to be rejected")
	}

	registryJSON, _ := json.Marshal(map[string]any{
		"plugins": []map[string]any{},
		"builtins": []map[string]any{{
			"id":          "beeftv-plugin-ll2",
			"packageName": "beeftv-plugin-ll2",
			"version":     "9.9.0",
			"tarball":     server.URL + "/beeftv-plugin-ll2-9.9.0.tgz",
			"sha256":      tgzSHA,
		}},
	})
	setCuratedRegistryForTest(string(registryJSON))

	check := svc.CheckUpdates(context.Background(), "")
	if len(check.Updates) != 1 || check.Updates[0].ID != "beeftv-plugin-ll2" || check.Updates[0].Latest != "9.9.0" || !check.Updates[0].Official {
		t.Fatalf("expected official hot update notice for beeftv-plugin-ll2, got %+v", check.Updates)
	}

	updated, err := svc.UpdatePackage("beeftv-plugin-ll2", "")
	if err != nil {
		t.Fatalf("UpdatePackage(beeftv-plugin-ll2) failed: %v", err)
	}
	if updated.Manifest.Version != "9.9.0" || updated.Source != OriginOfficial {
		t.Fatalf("unexpected updated builtin view: version=%q source=%q", updated.Manifest.Version, updated.Source)
	}
	if _, ok := svc.Registry().Resolve("ll2-future-hot-video"); !ok {
		t.Fatal("expected newly hot-updated provider ll2-future-hot-video to be live immediately")
	}

	// 重启后继续保留高于随包版本的热更新副本，不被旧随包目录倒退覆盖。
	rtRestarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("restart NewRuntime failed: %v", err)
	}
	svcRestarted := New(rtRestarted, nil)
	restartedView, ok := ByID(svcRestarted.List(), "beeftv-plugin-ll2")
	if !ok || restartedView.Manifest.Version != "9.9.0" || restartedView.Source != OriginOfficial {
		t.Fatalf("expected hot-updated version 9.9.0 to survive restart, got %+v", restartedView)
	}
	if _, ok := svcRestarted.Registry().Resolve("ll2-future-hot-video"); !ok {
		t.Fatal("expected hot-updated provider to remain registered after restart")
	}

	// 内容寻址目录默认只读保护：未改权限前直接写入必须失败。
	if !strings.Contains(restartedView.PackageDir, ".builtin-blobs") {
		t.Fatalf("expected content-addressed .builtin-blobs dir, got %q", restartedView.PackageDir)
	}
	clientJSPath := filepath.Join(restartedView.PackageDir, "client", "index.js")
	if info, statErr := os.Stat(clientJSPath); statErr != nil || info.Mode()&0o222 != 0 {
		t.Fatalf("expected read-only client/index.js, statErr=%v mode=%v", statErr, info)
	}

	// 运行期强行改权限并篡改文件时，ResolvePackageFile 立即拒绝下发并自动回退至随包版本。
	hotRev := restartedView.Manifest.Revision
	if revPath, _, revErr := svcRestarted.ResolvePackageFile("beeftv-plugin-ll2", "/@rev-"+hotRev+"/client/index.js"); revErr != nil || !strings.HasSuffix(revPath, "index.js") {
		t.Fatalf("expected @rev- prefixed file resolution to succeed before tamper, path=%q err=%v", revPath, revErr)
	}
	_ = os.Chmod(filepath.Dir(clientJSPath), 0o755)
	_ = os.Chmod(clientJSPath, 0o644)
	if err := os.WriteFile(clientJSPath, []byte("// tampered at runtime\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, resolveErr := svcRestarted.ResolvePackageFile("beeftv-plugin-ll2", "/@rev-"+hotRev+"/client/index.js"); resolveErr == nil {
		t.Fatal("expected ResolvePackageFile to reject tampered hot-update file")
	}
	// 前端随后针对已失效旧 revision 上报的 load-error 不会把已回退的随包安全版标为 invalid。
	afterStaleErr, staleErr := svcRestarted.SetLoadErrorAtRevision("beeftv-plugin-ll2", "Failed to fetch dynamically imported module", "import", hotRev)
	if staleErr != nil || afterStaleErr.Status != StatusEnabled || afterStaleErr.Error != "" {
		t.Fatalf("expected stale-revision SetLoadError after tamper rollback to keep shipped plugin enabled, got %+v err=%v", afterStaleErr, staleErr)
	}
	rolledBackLive, ok := ByID(svcRestarted.List(), "beeftv-plugin-ll2")
	if !ok || rolledBackLive.Manifest.Version == "9.9.0" || rolledBackLive.Status != StatusEnabled {
		t.Fatalf("expected runtime tamper to auto-rollback to shipped version, got %+v", rolledBackLive)
	}
	if _, ok := svcRestarted.Registry().Resolve("ll2-future-hot-video"); ok {
		t.Fatal("expected rolled-back runtime to unregister hot-updated provider")
	}
	if cleanPath, _, cleanErr := svcRestarted.ResolvePackageFile("beeftv-plugin-ll2", "client/index.js"); cleanErr != nil || strings.Contains(cleanPath, ".builtin-blobs") {
		t.Fatalf("expected subsequent ResolvePackageFile to serve shipped file, path=%q err=%v", cleanPath, cleanErr)
	}
}

func TestHotUpdatedBuiltinRollsBackOnLoadErrorAndRejectsSpoofedOrigin(t *testing.T) {
	tgzBytes, tgzSHA := buildTarballBytesForTest(t, map[string]string{
		"package.json": `{
			"name": "beeftv-plugin-ll2",
			"version": "9.9.1",
			"description": "hot updated ll2 with bad client",
			"beeftv": {
				"name": "LL2 算力与视频渠道",
				"client": "./client/index.js",
				"permissions": ["generation.run", "media.read", "ui.slot", "settings.write"],
				"configuration": { "fields": [{ "name": "apiKey", "type": "secret", "label": "Key", "required": true }] },
				"contributes": {
					"providers": [{
						"id": "ll2-broken-client-video",
						"label": "LL2 Broken Client Video",
						"capabilities": ["video"],
						"scopes": ["user.custom-channel", "canvas"],
						"baseUrl": "https://api.ll2.cn",
						"auth": { "type": "bearer", "field": "apiKey" },
						"create": { "method": "POST", "path": "/future/tasks", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
						"poll": { "method": "GET", "path": "/future/tasks/{{taskId}}", "originPath": true },
						"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
					}]
				}
			}
		}`,
		"client/index.js": "throw new Error('broken client bundle');\n",
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/beeftv-plugin-ll2-9.9.1.tgz" {
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(tgzBytes)
			return
		}
		http.NotFound(w, r)
	}))
	prevLoopback := allowLoopbackMarketURLsForTest
	allowLoopbackMarketURLsForTest = true
	t.Cleanup(func() {
		server.Close()
		allowLoopbackMarketURLsForTest = prevLoopback
		setCuratedRegistryForTest("")
		capability.BuiltinRegistry().ResetPluginDescriptors()
	})

	registryJSON, _ := json.Marshal(map[string]any{
		"plugins": []map[string]any{},
		"builtins": []map[string]any{{
			"id":          "beeftv-plugin-ll2",
			"packageName": "beeftv-plugin-ll2",
			"version":     "9.9.1",
			"tarball":     server.URL + "/beeftv-plugin-ll2-9.9.1.tgz",
			"sha256":      tgzSHA,
		}},
	})
	setCuratedRegistryForTest(string(registryJSON))

	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	hotUpdatedView, err := svc.UpdatePackage("beeftv-plugin-ll2", "")
	if err != nil {
		t.Fatalf("UpdatePackage failed: %v", err)
	}

	// 1. 不带 revision 的 SetLoadError 不允许绕过校验回滚热更新内置插件；携带匹配 revision 时立即回退到随包版本。
	ignoredNoRev, err := svc.SetLoadError("beeftv-plugin-ll2", "unverified caller error")
	if err != nil || ignoredNoRev.Manifest.Version != "9.9.1" || ignoredNoRev.Status != StatusEnabled {
		t.Fatalf("expected SetLoadError without revision to leave hot-updated builtin untouched, got %+v err=%v", ignoredNoRev, err)
	}
	recovered, err := svc.SetLoadErrorAtRevision("beeftv-plugin-ll2", "SyntaxError: broken client bundle", "import", hotUpdatedView.Manifest.Revision)
	if err != nil {
		t.Fatalf("SetLoadError failed: %v", err)
	}
	if recovered.Manifest.Version == "9.9.1" || recovered.Status != StatusEnabled || recovered.Error != "" {
		t.Fatalf("expected SetLoadError on hot-updated builtin to auto-rollback cleanly, got %+v", recovered)
	}
	if _, ok := svc.Registry().Resolve("ll2-wan3-video"); !ok {
		t.Fatal("expected shipped ll2-wan3-video provider to remain available after rollback")
	}

	// 2. 若磁盘/数据库残留了带 LoadError 的热更新记录或 OriginPackage 伪造记录，重启时全部拒绝并回退到随包官方版。
	if _, err := svc.UpdatePackage("beeftv-plugin-ll2", ""); err != nil {
		t.Fatalf("re-UpdatePackage failed: %v", err)
	}
	spoofedDir := filepath.Join(dataDir, "plugins", "beeftv-plugin-ysdui")
	writePluginFolder(t, spoofedDir, map[string]string{
		"package.json":    `{"name":"beeftv-plugin-ysdui","version":"9.9.9","beeftv":{"name":"Spoofed Ysdui","client":"./client/index.js"}}`,
		"client/index.js": "export function activate() {}\n",
	})
	spoofedPkg, err := protocol.ParsePluginPackageDir(spoofedDir)
	if err != nil {
		t.Fatal(err)
	}
	records, err := rt.currentRecords()
	if err != nil {
		t.Fatal(err)
	}
	for i := range records {
		if records[i].ID == "beeftv-plugin-ll2" {
			records[i].LoadError = "persisted import timeout"
		}
		if records[i].ID == "beeftv-plugin-ysdui" {
			records[i].Source = OriginPackage
			records[i].Raw = spoofedPkg.ManifestRaw
			records[i].PackageDir = spoofedPkg.RootDir
			records[i].PackageSpec = "beeftv-plugin-ysdui"
			records[i].PackageSHA256 = spoofedPkg.SHA256
		}
	}
	registryData, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), registryData, 0o600); err != nil {
		t.Fatal(err)
	}

	rtBoot, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("NewRuntime after persisted LoadError & spoofed OriginPackage failed: %v", err)
	}
	svcBoot := New(rtBoot, nil)
	ll2Boot, ok := ByID(svcBoot.List(), "beeftv-plugin-ll2")
	if !ok || ll2Boot.Manifest.Version == "9.9.1" || ll2Boot.Status != StatusEnabled || ll2Boot.Error != "" {
		t.Fatalf("expected persisted LoadError hot-update to fall back cleanly on boot, got %+v", ll2Boot)
	}
	ysduiBoot, ok := ByID(svcBoot.List(), "beeftv-plugin-ysdui")
	if !ok || ysduiBoot.Manifest.Version == "9.9.9" || ysduiBoot.Source != OriginOfficial {
		t.Fatalf("expected spoofed OriginPackage record to be rejected on boot, got %+v", ysduiBoot)
	}
}
