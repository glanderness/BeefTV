package plugins

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/kernel"
)

type stubReferenceSource struct {
	usage map[string]ReferenceUsage
}

func (s stubReferenceSource) ReferencedProviders() (map[string]ReferenceUsage, error) {
	return s.usage, nil
}

func TestBuiltinHotUpdateRetainsPreviousRevDefersReferencedRemovalAndRejectsSymlinks(t *testing.T) {
	v1Bytes, v1SHA := buildTarballBytesForTest(t, map[string]string{
		"package.json": `{
			"name": "beeftv-plugin-ll2",
			"version": "9.9.1",
			"description": "hot v1",
			"beeftv": {
				"name": "LL2",
				"client": "./client/index.js",
				"permissions": ["generation.run", "media.read", "ui.slot", "settings.write"],
				"configuration": { "fields": [{ "name": "apiKey", "type": "secret", "label": "Key", "required": true }] },
				"contributes": {
					"providers": [
						{
							"id": "ll2-wan3-video",
							"label": "Wan3",
							"capabilities": ["video"],
							"scopes": ["user.custom-channel", "canvas"],
							"baseUrl": "https://api.ll2.cn",
							"auth": { "type": "bearer", "field": "apiKey" },
							"create": { "method": "POST", "path": "/wan3", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
							"poll": { "method": "GET", "path": "/wan3/{{taskId}}", "originPath": true },
							"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
						},
						{
							"id": "ll2-v1-only-video",
							"label": "V1 Only",
							"capabilities": ["video"],
							"scopes": ["user.custom-channel", "canvas"],
							"baseUrl": "https://api.ll2.cn",
							"auth": { "type": "bearer", "field": "apiKey" },
							"create": { "method": "POST", "path": "/v1only", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
							"poll": { "method": "GET", "path": "/v1only/{{taskId}}", "originPath": true },
							"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
						}
					]
				}
			}
		}`,
		"client/index.js":   "import { V } from './presets.js'; export { V };\n",
		"client/presets.js": "export const V = '9.9.1';\n",
	})
	v2Bytes, v2SHA := buildTarballBytesForTest(t, map[string]string{
		"package.json": `{
			"name": "beeftv-plugin-ll2",
			"version": "9.9.2",
			"description": "hot v2 drops ll2-v1-only-video",
			"beeftv": {
				"name": "LL2",
				"client": "./client/index.js",
				"permissions": ["generation.run", "media.read", "ui.slot", "settings.write"],
				"configuration": { "fields": [{ "name": "apiKey", "type": "secret", "label": "Key", "required": true }] },
				"contributes": {
					"providers": [{
						"id": "ll2-wan3-video",
						"label": "Wan3",
						"capabilities": ["video"],
						"scopes": ["user.custom-channel", "canvas"],
						"baseUrl": "https://api.ll2.cn",
						"auth": { "type": "bearer", "field": "apiKey" },
						"create": { "method": "POST", "path": "/wan3", "originPath": true, "contentType": "application/json", "body": { "model": { "$ref": "request.model" } } },
						"poll": { "method": "GET", "path": "/wan3/{{taskId}}", "originPath": true },
						"response": { "taskId": { "$ref": "response.id" }, "status": { "$ref": "response.status" }, "videos": { "$ref": "response.url" } }
					}]
				}
			}
		}`,
		"client/index.js":   "import { V } from './presets.js'; export { V };\n",
		"client/presets.js": "export const V = '9.9.2';\n",
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ll2-9.9.1.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(v1Bytes)
		case "/ll2-9.9.2.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(v2Bytes)
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
	rt, err := newRuntime(dataDir, nil, refs)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	shippedView, ok := ByID(svc.List(), "beeftv-plugin-ll2")
	if !ok {
		t.Fatal("missing shipped beeftv-plugin-ll2")
	}
	shippedRev := shippedView.Manifest.Revision

	// 1. 热更新到 9.9.1 后，当前热版本与随包旧版本的 @rev 路径均可正常解析。
	reg1, _ := json.Marshal(map[string]any{
		"plugins": []map[string]any{},
		"builtins": []map[string]any{{
			"id": "beeftv-plugin-ll2", "packageName": "beeftv-plugin-ll2", "version": "9.9.1",
			"tarball": server.URL + "/ll2-9.9.1.tgz", "sha256": v1SHA,
		}},
	})
	setCuratedRegistryForTest(string(reg1))
	v1View, err := svc.UpdatePackage("beeftv-plugin-ll2", "")
	if err != nil {
		t.Fatalf("update to 9.9.1 failed: %v", err)
	}
	v1Rev := v1View.Manifest.Revision
	if _, _, err := svc.ResolvePackageFile("beeftv-plugin-ll2", "/@rev-"+shippedRev+"/client/index.js"); err != nil {
		t.Fatalf("expected shipped @rev file to remain resolvable, err=%v", err)
	}

	// 2. 当 9.9.2 删除了仍被未完成任务引用的 ll2-v1-only-video 时，热更新被拒绝（plugin_update_deferred），旧定义保留。
	refs.usage["ll2-v1-only-video"] = ReferenceUsage{PendingTasks: 1}
	reg2, _ := json.Marshal(map[string]any{
		"plugins": []map[string]any{},
		"builtins": []map[string]any{{
			"id": "beeftv-plugin-ll2", "packageName": "beeftv-plugin-ll2", "version": "9.9.2",
			"tarball": server.URL + "/ll2-9.9.2.tgz", "sha256": v2SHA,
		}},
	})
	setCuratedRegistryForTest(string(reg2))
	var appErr *kernel.AppError
	if _, deferErr := svc.UpdatePackage("beeftv-plugin-ll2", ""); deferErr == nil {
		t.Fatal("expected UpdatePackage to defer when removing a referenced provider")
	} else if !errors.As(deferErr, &appErr) || appErr.Reason != "plugin_update_deferred" || appErr.Status != http.StatusConflict {
		t.Fatalf("expected 409 plugin_update_deferred error, got %#v (err=%v)", appErr, deferErr)
	}
	if _, stillOK := svc.Registry().Resolve("ll2-v1-only-video"); !stillOK {
		t.Fatal("expected referenced ll2-v1-only-video provider to remain registered")
	}

	// 3. 引用释放后允许升级到 9.9.2，且切换窗口保留上一版热更新 9.9.1 的 @rev 相对模块文件防 404。
	delete(refs.usage, "ll2-v1-only-video")
	v2View, err := svc.UpdatePackage("beeftv-plugin-ll2", "")
	if err != nil {
		t.Fatalf("update to 9.9.2 after reference cleared failed: %v", err)
	}
	v2Path, _, err := svc.ResolvePackageFile("beeftv-plugin-ll2", "/@rev-"+v2View.Manifest.Revision+"/client/presets.js")
	if err != nil {
		t.Fatalf("expected v2 @rev presets.js to resolve: %v", err)
	}
	v2Content, _ := os.ReadFile(v2Path)
	if !strings.Contains(string(v2Content), "9.9.2") {
		t.Fatalf("expected v2 presets.js content, got %q", string(v2Content))
	}
	v1RetainedPath, _, err := svc.ResolvePackageFile("beeftv-plugin-ll2", "/@rev-"+v1Rev+"/client/presets.js")
	if err != nil {
		t.Fatalf("expected retained previous v1 @rev presets.js to resolve without 404: %v", err)
	}
	v1Content, _ := os.ReadFile(v1RetainedPath)
	if !strings.Contains(string(v1Content), "9.9.1") {
		t.Fatalf("expected retained v1 presets.js content, got %q", string(v1Content))
	}

	// 4. 含符号链接的暂存目录在 stageHotUpdatedBuiltinBlob 阶段直接拒绝，绝不跟随链接 chmod 包外文件。
	outsideFile := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	symlinkStage := filepath.Join(t.TempDir(), "stage-symlink")
	writePluginFolder(t, symlinkStage, map[string]string{
		"package.json": `{"name":"beeftv-plugin-ll2","version":"9.9.3","beeftv":{"client":"./client/index.js"}}`,
	})
	if err := os.MkdirAll(filepath.Join(symlinkStage, "client"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(symlinkStage, "client", "index.js")); err != nil {
		if goruntime.GOOS == "windows" {
			t.Skipf("skipping symlink test on Windows without symlink privilege: %v", err)
		}
		t.Fatal(err)
	}
	if _, _, symErr := stageHotUpdatedBuiltinBlob(dataDir, "beeftv-plugin-ll2", symlinkStage, ".", strings.Repeat("c", 64)); symErr == nil {
		t.Fatal("expected stageHotUpdatedBuiltinBlob to reject symlink inside staged package")
	}
	if info, err := os.Stat(outsideFile); err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("expected outside symlink target permissions untouched (0644), got %v err=%v", info, err)
	}
}
