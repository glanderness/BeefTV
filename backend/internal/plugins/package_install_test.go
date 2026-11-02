package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/protocol"
)

func writeSamplePluginDir(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "skills", "storyboard-grid"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dist", "client.js"), []byte("export function activate(ctx) {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skills", "storyboard-grid", "SKILL.md"), []byte("---\nname: 分镜九宫格\ndescription: 拆解九宫格\n---\n# 分镜九宫格\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "index.ts"), []byte("export default function() {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkgJSON := `{
		"name": "@beeftv/plugin-storyboard-grid-test",
		"version": "` + version + `",
		"description": "测试分镜九宫格插件",
		"author": "BeefTV",
		"pi": {
			"extensions": ["./extensions/index.ts"],
			"skills": ["./skills"]
		},
		"beeftv": {
			"id": "storyboard-grid-test",
			"displayName": "分镜九宫格测试",
			"client": "./dist/client.js",
			"contributes": {
				"canvasNodes": [
					{
						"type": "storyboard-grid-test",
						"title": "分镜九宫格测试",
						"defaultWidth": 520,
						"defaultHeight": 420,
						"renderer": "client"
					}
				]
			}
		}
	}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPackageInstallLifecycleCanvasSyncAndSkillHook(t *testing.T) {
	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("NewRuntime failed: %v", err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()

	svc := New(rt, nil)
	syncedSkills := map[string]bool{}
	svc.SetSkillSyncHook(func(pluginID, pluginName, version string, skillDirs []string, enabled bool) {
		if enabled && len(skillDirs) > 0 {
			syncedSkills[pluginID] = true
		} else {
			delete(syncedSkills, pluginID)
		}
	})

	srcDir := writeSamplePluginDir(t, "1.0.0")
	view, err := svc.InstallPackageFromDir(srcDir, srcDir)
	if err != nil {
		t.Fatalf("InstallPackageFromDir failed: %v", err)
	}
	if view.Manifest.ID != "storyboard-grid-test" || view.Status != StatusEnabled || view.Source != OriginPackage {
		t.Fatalf("unexpected installed view: %#v", view)
	}
	if !syncedSkills["storyboard-grid-test"] {
		t.Fatal("expected skill sync hook to be called with enabled=true")
	}
	if _, ok := capability.BuiltinRegistry().Resolve("storyboard-grid-test"); !ok {
		t.Fatal("expected storyboard-grid-test canvas node descriptor to be registered")
	}
	enabledPkgs := svc.EnabledPackages()
	foundEnabled := false
	for _, p := range enabledPkgs {
		if p.ID == "storyboard-grid-test" && p.Client == "./dist/client.js" {
			foundEnabled = true
		}
	}
	if !foundEnabled {
		t.Fatalf("expected storyboard-grid-test in EnabledPackages, got %#v", enabledPkgs)
	}

	resolvedPath, mimeType, err := svc.ResolvePackageFile("storyboard-grid-test", "dist/client.js")
	if err != nil || resolvedPath == "" || mimeType != "application/javascript; charset=utf-8" {
		t.Fatalf("ResolvePackageFile failed: path=%q mime=%q err=%v", resolvedPath, mimeType, err)
	}
	if _, _, err := svc.ResolvePackageFile("storyboard-grid-test", "../escape.js"); err == nil {
		t.Fatal("expected path traversal to be rejected")
	}
	if _, _, err := svc.ResolvePackageFile("storyboard-grid-test", "extensions/index.ts"); err == nil {
		t.Fatal("expected non-web file extension .ts to be rejected")
	}

	disabledView, err := svc.SetEnabled("storyboard-grid-test", false)
	if err != nil || disabledView.Status != StatusDisabled {
		t.Fatalf("SetEnabled(false) failed: %#v, err=%v", disabledView, err)
	}
	if _, ok := capability.BuiltinRegistry().Resolve("storyboard-grid-test"); ok {
		t.Fatal("expected canvas node descriptor to be removed when plugin is disabled")
	}
	if syncedSkills["storyboard-grid-test"] {
		t.Fatal("expected skill hook to remove skills when plugin is disabled")
	}

	if _, err := svc.SetEnabled("storyboard-grid-test", true); err != nil {
		t.Fatalf("SetEnabled(true) failed: %v", err)
	}
	invalidView, err := svc.SetLoadError("storyboard-grid-test", "Extension syntax error")
	if err != nil || invalidView.Status != StatusInvalid || invalidView.Error != "Extension syntax error" {
		t.Fatalf("SetLoadError failed: %#v, err=%v", invalidView, err)
	}
	if _, ok := capability.BuiltinRegistry().Resolve("storyboard-grid-test"); ok {
		t.Fatal("expected canvas node descriptor to be removed when plugin enters StatusInvalid")
	}

	if err := svc.Uninstall("storyboard-grid-test"); err != nil {
		t.Fatalf("Uninstall failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "plugins", "storyboard-grid-test")); !os.IsNotExist(err) {
		t.Fatalf("expected installed package dir to be removed on uninstall, err=%v", err)
	}
}

func TestInstallPackageFromTarGzArchive(t *testing.T) {
	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	files := map[string]string{
		"package/package.json": `{
			"name": "@beeftv/plugin-archive-demo",
			"version": "1.0.0",
			"description": "Archive demo",
			"beeftv": {
				"id": "archive-demo",
				"name": "Archive Demo",
				"client": "./dist/client.js"
			}
		}`,
		"package/dist/client.js": "export function activate() {}",
	}
	for name, content := range files {
		hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	_ = tw.Close()
	_ = gz.Close()

	view, err := svc.InstallPackageFromArchive(buf.Bytes(), "archive-demo-1.0.0.tgz")
	if err != nil {
		t.Fatalf("InstallPackageFromArchive failed: %v", err)
	}
	if view.Manifest.ID != "archive-demo" || view.Status != StatusEnabled {
		t.Fatalf("unexpected view: %#v", view)
	}
}

func TestBuiltinLL2PluginPreinstalledAndRegistersProviders(t *testing.T) {
	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("NewRuntime failed: %v", err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)

	view, ok := ByID(svc.List(), "beeftv-plugin-ll2")
	if !ok {
		t.Fatal("expected beeftv-plugin-ll2 to be pre-installed by default")
	}
	if view.Status != StatusEnabled || view.Source != OriginOfficial {
		t.Fatalf("unexpected beeftv-plugin-ll2 view: status=%q source=%q", view.Status, view.Source)
	}
	if view.Management.ConfigurationScope != ConfigurationUser || view.Management.ActivationScope != ScopeUser {
		t.Fatalf("expected ScopeUser/ConfigurationUser for beeftv-plugin-ll2, got activation=%q config=%q", view.Management.ActivationScope, view.Management.ConfigurationScope)
	}

	reg := svc.Registry()
	cases := []struct {
		providerID string
		req        protocol.GenerationRequest
		wantPath   string
		pollJSON   string
	}{
		{
			providerID: "ll2-seedance-video",
			req:        protocol.GenerationRequest{Model: "doubao-seedance-2-0-fast", Prompt: "hello", Duration: 4, AspectRatio: "16:9", Resolution: "720p"},
			wantPath:   "/seedance/api/v3/contents/generations/tasks",
			pollJSON:   `{"id":"cgt-1","status":"succeeded","content":{"video_url":"https://cdn.example.com/a.mp4"}}`,
		},
		{
			providerID: "ll2-vidu-video",
			req:        protocol.GenerationRequest{Model: "viduq3-turbo", Prompt: "hello", Duration: 5, AspectRatio: "16:9", Resolution: "720p"},
			wantPath:   "/vidu/ent/v2/text2video",
			pollJSON:   `{"id":"vidu-1","state":"success","creations":[{"url":"https://cdn.example.com/b.mp4"}]}`,
		},
		{
			providerID: "ll2-minimax-video",
			req:        protocol.GenerationRequest{Model: "MiniMax-H3", Prompt: "hello", Duration: 5, AspectRatio: "16:9", Resolution: "720P"},
			wantPath:   "/v2/video_generation",
			pollJSON:   `{"task_id":"mm-1","status":"Success","video_url":"https://cdn.example.com/c.mp4"}`,
		},
		{
			providerID: "ll2-super-vega-video",
			req:        protocol.GenerationRequest{Model: "1.0-pro-mini", Prompt: "hello", Duration: 4, AspectRatio: "16:9", Resolution: "720P"},
			wantPath:   "/super-vega/tasks",
			pollJSON:   `{"Response":{"Status":"FINISH","AigcVideoTask":{"TaskId":"sv-1","Output":{"FileInfos":[{"FileUrl":"https://cdn.example.com/d.mp4"}]}}}}`,
		},
		{
			providerID: "ll2-auto-hd-video",
			req:        protocol.GenerationRequest{Model: "auto-hd", Videos: []protocol.MediaReference{{URL: "https://cdn.example.com/src.mp4"}}, Resolution: "1080p"},
			wantPath:   "/hd/tasks",
			pollJSON:   `{"task_id":"hd-1","status":"finished","url":"https://cdn.example.com/e.mp4"}`,
		},
	}
	for _, tc := range cases {
		adapter, resolved := reg.Resolve(tc.providerID)
		if !resolved {
			t.Fatalf("expected provider %q from beeftv-plugin-ll2 to be registered in protocol registry", tc.providerID)
		}
		spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://api.ll2.cn",
			Request: tc.req,
		})
		if err != nil {
			t.Fatalf("BuildCreate(%s) failed: %v", tc.providerID, err)
		}
		if spec.Path != tc.wantPath {
			t.Fatalf("BuildCreate(%s) path = %q, want %q", tc.providerID, spec.Path, tc.wantPath)
		}
		polled, err := adapter.ParsePoll(context.Background(), protocol.PollContext{
			BaseURL: "https://api.ll2.cn",
			Model:   tc.req.Model,
			Request: tc.req,
			TaskID:  "task-1",
		}, []byte(tc.pollJSON))
		if err != nil {
			t.Fatalf("ParsePoll(%s) failed: %v", tc.providerID, err)
		}
		if polled.Status != protocol.StatusSucceeded || len(polled.Result.Videos) != 1 {
			t.Fatalf("ParsePoll(%s) unexpected result: status=%q videos=%v", tc.providerID, polled.Status, polled.Result.Videos)
		}
	}
}

