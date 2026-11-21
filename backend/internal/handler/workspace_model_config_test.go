package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestWorkspaceModelConfigReturnsBuiltinBeefTVAndPersistenceMetadata(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	data := modelConfigResponseData(t, recorder)
	if data["health"] != string(workspace.ConfigHealthDefault) || data["revision"] != float64(0) || data["source"] != "builtin+local" {
		t.Fatalf("missing persistence metadata: %#v", data)
	}
	config, _ := data["config"].(map[string]any)
	channels, _ := config["channels"].([]any)
	if len(channels) != 1 || channels[0].(map[string]any)["id"] != "beeftv" {
		t.Fatalf("builtin BeefTV missing: %#v", channels)
	}
	if models, _ := channels[0].(map[string]any)["models"].([]any); len(models) != 0 {
		t.Fatalf("model catalog must remain dynamic: %#v", models)
	}
}

func TestWorkspaceModelConfigGETRedactsBeefTVKey(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	first := putModelConfig(t, router, 0, "local-secret-key")
	if first.Code != http.StatusOK {
		t.Fatalf("put status = %d body=%s", first.Code, first.Body.String())
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if bytes.Contains(recorder.Body.Bytes(), []byte("local-secret-key")) {
		t.Fatalf("model-config leaked api key: %s", recorder.Body.String())
	}
	stale := putModelConfig(t, router, 1, "ui-overwrite")
	if stale.Code != http.StatusOK {
		t.Fatalf("second put status = %d body=%s", stale.Code, stale.Body.String())
	}
}

func TestWorkspaceModelConfigRejectsStaleRevisionWithoutLeakingSecrets(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	first := putModelConfig(t, router, 0, "first-secret")
	if first.Code != http.StatusOK {
		t.Fatalf("first put status = %d body=%s", first.Code, first.Body.String())
	}
	if revision := modelConfigResponseData(t, first)["revision"]; revision != float64(1) {
		t.Fatalf("committed revision = %#v", revision)
	}

	stale := putModelConfig(t, router, 0, "must-not-leak")
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale put status = %d body=%s", stale.Code, stale.Body.String())
	}
	if bytes.Contains(stale.Body.Bytes(), []byte("must-not-leak")) || bytes.Contains(stale.Body.Bytes(), []byte("first-secret")) {
		t.Fatalf("error response leaked a secret: %s", stale.Body.String())
	}
}

func newModelConfigTestRouter(t *testing.T) (*gin.Engine, *workspace.ProviderConfig) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(nil, dir)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
	RegisterWorkspaceRoutes(router.Group("/api"), service)
	return router, store
}

func putModelConfig(t *testing.T, router *gin.Engine, expectedRevision int64, apiKey string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"expectedRevision": expectedRevision,
		"config":           map[string]any{"channels": []any{map[string]any{"id": "beeftv", "apiKey": apiKey, "enabled": true}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

func modelConfigResponseData(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func TestWorkspaceModelConfigCapabilityNormalizesDrafts(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)

	cases := []struct {
		name       string
		payload    map[string]any
		wantStatus int
		check      func(t *testing.T, data map[string]any)
	}{
		{
			name: "unsaved custom Seedance 2.5 draft returns tightened video capability and taskTypeConstraints",
			payload: map[string]any{
				"type":          "video",
				"interfaceType": "newapi-channel-2",
				"model":         "bytedance/dreamina-seedance-2-5-flash",
				"baseUrl":       "https://beeftv.app/v1",
				"capabilityConfig": map[string]any{
					"version": 1,
					"video": map[string]any{
						"operations":        []string{"text_to_video", "reference_to_video"},
						"defaultOperation":  "text_to_video",
						"duration":          map[string]any{"selection": "range", "min": 1, "max": 15, "step": 1, "default": 2},
						"ratios":            []string{"16:9"},
						"defaultRatio":      "16:9",
						"resolutions":       []string{"480p", "720p"},
						"defaultResolution": "720p",
						"references": map[string]any{
							"maxImages":               30,
							"maxVideos":               10,
							"maxAudios":               10,
							"minVideoDurationSeconds": 1,
							"maxVideoDurationSeconds": 15,
							"minAudioDurationSeconds": 1,
							"maxAudioDurationSeconds": 15,
						},
					},
				},
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, data map[string]any) {
				video, ok := data["video"].(map[string]any)
				if !ok {
					t.Fatalf("missing video capability: %#v", data)
				}
				if video["taskTypeConstraints"] != true {
					t.Fatalf("taskTypeConstraints = %#v, want true", video["taskTypeConstraints"])
				}
				duration, _ := video["duration"].(map[string]any)
				if duration["min"] != float64(4) || duration["default"] != float64(4) {
					t.Fatalf("duration not tightened to 4s floor: %#v", duration)
				}
				refs, _ := video["references"].(map[string]any)
				if refs["minAudioDurationSeconds"] != float64(2) || refs["minVideoDurationSeconds"] != float64(1) {
					t.Fatalf("reference audio/video floors not tightened: %#v", refs)
				}
				if refs["minVideoPixels"] != float64(407696) {
					t.Fatalf("minVideoPixels = %#v, want 407696", refs["minVideoPixels"])
				}
			},
		},
		{
			name: "openai-response text draft returns thinking=true",
			payload: map[string]any{
				"category": "text",
				"protocol": "openai-response",
				"model":    "gpt-5.4",
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, data map[string]any) {
				text, ok := data["text"].(map[string]any)
				if !ok || text["thinking"] != true {
					t.Fatalf("text capability = %#v, want thinking=true", data["text"])
				}
			},
		},
		{
			name: "invalid capability category returns 400",
			payload: map[string]any{
				"category": "invalid-capability",
				"protocol": "openai",
				"model":    "gpt-4o",
			},
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.payload)
			if err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/workspace/model-config/capability", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, req)
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.wantStatus, recorder.Body.String())
			}
			if tc.check != nil {
				tc.check(t, modelConfigResponseData(t, recorder))
			}
		})
	}
}

func TestRegisterCanvasAPINormalizesInstalledPluginWorkflow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	svc := app.NewLocal(repository.New(db), dir)
	t.Cleanup(func() { _ = svc.Close() })
	if _, err := svc.LocalWorkspaceOwner(); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	registerTestCanvasAPI(router.Group("/api"), svc)

	raw, err := json.Marshal(map[string]any{
		"category": "video",
		"protocol": "autodl-comfyui",
		"model":    "minimax_h3_b99_003_12s",
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workspace/model-config/capability", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	data := modelConfigResponseData(t, recorder)
	video, ok := data["video"].(map[string]any)
	if !ok {
		t.Fatalf("missing video capability: %#v", data)
	}
	ratios, _ := video["ratios"].([]any)
	if len(ratios) != 0 || video["defaultRatio"] != "" {
		t.Fatalf("ratios = %#v (default %#v), want empty", ratios, video["defaultRatio"])
	}
	resolutions, _ := video["resolutions"].([]any)
	if len(resolutions) != 3 || video["defaultResolution"] != "736p竖" {
		t.Fatalf("resolutions = %#v (default %#v), want 3 directional 736p tiers", resolutions, video["defaultResolution"])
	}
	duration, _ := video["duration"].(map[string]any)
	if duration["selection"] != "range" || duration["min"] != float64(1) || duration["max"] != float64(12) || duration["default"] != float64(5) {
		t.Fatalf("duration = %#v, want range 1..12 default 5", duration)
	}
}

func TestWorkspaceModelConfigRecoversAndSavesAfterPrimaryCorruption(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(nil, dir)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
	RegisterWorkspaceRoutes(router.Group("/api"), service)

	// 连续写入两次以生成有效 .bak（revision 1）。
	first := putModelConfig(t, router, 0, "first-secret")
	if first.Code != http.StatusOK {
		t.Fatalf("first put status = %d body=%s", first.Code, first.Body.String())
	}
	second := putModelConfig(t, router, 1, "second-secret")
	if second.Code != http.StatusOK {
		t.Fatalf("second put status = %d body=%s", second.Code, second.Body.String())
	}

	// 模拟主配置文件损坏。
	primaryPath := filepath.Join(dir, workspace.LocalProviderConfigFile)
	if err := os.WriteFile(primaryPath, []byte(`{"schemaVersion":`), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. GET 降级返回备份与 health=recovered。
	getRec := httptest.NewRecorder()
	router.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if getRec.Code != http.StatusOK {
		t.Fatalf("get status = %d body=%s", getRec.Code, getRec.Body.String())
	}
	data := modelConfigResponseData(t, getRec)
	if data["health"] != string(workspace.ConfigHealthRecovered) || data["revision"] != float64(1) {
		t.Fatalf("unexpected recovery metadata: %#v", data)
	}

	// 2. 启动自动恢复写回或用户编辑自定义渠道保存都不应再陷入 500 死锁。
	saveBody, err := json.Marshal(map[string]any{
		"expectedRevision": 1,
		"config": map[string]any{
			"channels": []any{
				map[string]any{"id": "beeftv", "apiKey": "", "enabled": true},
				map[string]any{
					"id":      "custom-sd",
					"name":    "sd 2.5",
					"apiKey":  "custom-key",
					"enabled": true,
					"models":  []string{"seedance-2-5-special"},
					"modelProfiles": []any{
						map[string]any{
							"model":      "seedance-2-5-special",
							"capability": "video",
							"capabilityConfig": map[string]any{
								"version": 1,
								"video": map[string]any{
									"duration": map[string]any{"selection": "range", "min": 1, "max": 15, "step": 1, "default": 5},
								},
							},
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	putRec := httptest.NewRecorder()
	putReq := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(saveBody))
	putReq.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("recovery put status = %d body=%s", putRec.Code, putRec.Body.String())
	}
	if rev := modelConfigResponseData(t, putRec)["revision"]; rev != float64(2) {
		t.Fatalf("revision = %#v, want 2", rev)
	}

	// 3. 下一次 GET 回到 ready。
	afterRec := httptest.NewRecorder()
	router.ServeHTTP(afterRec, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if afterRec.Code != http.StatusOK {
		t.Fatalf("after get status = %d body=%s", afterRec.Code, afterRec.Body.String())
	}
	if got := modelConfigResponseData(t, afterRec)["health"]; got != string(workspace.ConfigHealthReady) {
		t.Fatalf("after health = %#v, want ready", got)
	}
}

func TestWorkspaceModelConfigReturnsExplicitBusinessErrors(t *testing.T) {
	t.Run("corrupt_without_backup", func(t *testing.T) {
		gin.SetMode(gin.TestMode)
		dir := t.TempDir()
		store, err := workspace.NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, workspace.LocalProviderConfigFile), []byte(`{"schemaVersion":`), 0o600); err != nil {
			t.Fatal(err)
		}
		service := app.NewLocal(nil, dir)
		router := gin.New()
		router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
		router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
		RegisterWorkspaceRoutes(router.Group("/api"), service)

		rec := putModelConfig(t, router, 0, "do-not-leak")
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		var body struct {
			Reason string `json:"reason"`
			Msg    string `json:"msg"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Reason != "provider_config_corrupt" || !strings.Contains(body.Msg, "损坏") {
			t.Fatalf("unexpected error payload: %+v", body)
		}
		if bytes.Contains(rec.Body.Bytes(), []byte("do-not-leak")) {
			t.Fatalf("error leaked secret: %s", rec.Body.String())
		}
	})

	t.Run("corrupt_ciphertext_without_backup", func(t *testing.T) {
		for _, tc := range []struct {
			name    string
			corrupt []byte
		}{
			{name: "invalid_format", corrupt: []byte(`{"schemaVersion":2,"encryptedConfig":"enc:v1:not-valid-cipher"}`)},
			{name: "short_nonce", corrupt: []byte(`{"schemaVersion":2,"encryptedConfig":"enc:v1:AAAA"}`)},
		} {
			t.Run(tc.name, func(t *testing.T) {
				gin.SetMode(gin.TestMode)
				dir := t.TempDir()
				store, err := workspace.NewProviderConfig(dir)
				if err != nil {
					t.Fatal(err)
				}
				if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","apiKey":"seed"}]}`)); err != nil {
					t.Fatal(err)
				}
				_ = os.Remove(filepath.Join(dir, workspace.LocalProviderConfigFile+".bak"))
				primaryPath := filepath.Join(dir, workspace.LocalProviderConfigFile)
				if err := os.WriteFile(primaryPath, tc.corrupt, 0o600); err != nil {
					t.Fatal(err)
				}

				service := app.NewLocal(nil, dir)
				router := gin.New()
				router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
				router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
				RegisterWorkspaceRoutes(router.Group("/api"), service)

				rec := putModelConfig(t, router, 1, "do-not-leak")
				if rec.Code != http.StatusInternalServerError {
					t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
				}
				var body struct {
					Reason string `json:"reason"`
					Msg    string `json:"msg"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body.Reason != "provider_config_corrupt" || !strings.Contains(body.Msg, "损坏") {
					t.Fatalf("unexpected error payload: %+v", body)
				}
				if bytes.Contains(rec.Body.Bytes(), []byte("do-not-leak")) {
					t.Fatalf("error leaked secret: %s", rec.Body.String())
				}
				gotPrimary, err := os.ReadFile(primaryPath)
				if err != nil || !bytes.Equal(gotPrimary, tc.corrupt) {
					t.Fatalf("primary modified on rejected corrupt write: err=%v body=%q", err, gotPrimary)
				}
			})
		}
	})

	t.Run("missing_settings_key", func(t *testing.T) {
		gin.SetMode(gin.TestMode)
		dir := t.TempDir()
		store, err := workspace.NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","apiKey":"secret-value"}]}`)); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dir, ".settings-key")); err != nil {
			t.Fatal(err)
		}
		service := app.NewLocal(nil, dir)
		router := gin.New()
		router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
		router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
		RegisterWorkspaceRoutes(router.Group("/api"), service)

		rec := putModelConfig(t, router, 1, "new-secret")
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
		var body struct {
			Reason string `json:"reason"`
			Msg    string `json:"msg"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Reason != "provider_config_key_unavailable" || !strings.Contains(body.Msg, "密钥") {
			t.Fatalf("unexpected error payload: %+v", body)
		}
	})

	t.Run("unmatched_redacted_secret_and_non_object_return_400", func(t *testing.T) {
		router, _ := newModelConfigTestRouter(t)
		first := putModelConfig(t, router, 0, "seed-secret")
		if first.Code != http.StatusOK {
			t.Fatalf("seed put status = %d body=%s", first.Code, first.Body.String())
		}

		unmatchedBody, _ := json.Marshal(map[string]any{
			"expectedRevision": 1,
			"config":           map[string]any{"channels": []any{map[string]any{"id": "unknown", "apiKey": workspace.RedactedSecret}}},
		})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(unmatchedBody))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("unmatched status = %d body=%s", rec.Code, rec.Body.String())
		}
		var unmatched struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &unmatched); err != nil || unmatched.Reason != "provider_config_unmatched_secret" {
			t.Fatalf("unmatched body = %s", rec.Body.String())
		}

		arrayRec := httptest.NewRecorder()
		arrayReq := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader([]byte(`{"expectedRevision":1,"config":["bad"]}`)))
		arrayReq.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(arrayRec, arrayReq)
		if arrayRec.Code != http.StatusBadRequest {
			t.Fatalf("array status = %d body=%s", arrayRec.Code, arrayRec.Body.String())
		}
	})
}
