package beeftv

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/workspace"
)

func seedConnectedCatalogService(
	t *testing.T,
	server *httptest.Server,
	mutateState func(*persistedState),
	mutateOpts func(*Options),
) (*Service, *workspace.ProviderConfig, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := encryptSecret(dir, "ent-secret-key")
	if err != nil {
		t.Fatal(err)
	}
	state := persistedState{
		SchemaVersion:       connectionSchema,
		AuthorizationOrigin: server.URL,
		ProviderBaseURL:     server.URL,
		Status:              StateConnected,
		EncryptedAPIKey:     encrypted,
		Market:              "enterprise",
		Group:               "enterprise",
		Account:             &Account{ID: "42", Username: "ender"},
		TokenID:             "9",
		Acked:               true,
		CatalogOK:           true,
		Balance:             BalanceAvailable,
	}
	if mutateState != nil {
		mutateState(&state)
	}
	if err := saveState(dir, state); err != nil {
		t.Fatal(err)
	}
	opts := Options{
		DataDir:             dir,
		Origin:              server.URL,
		HTTPClient:          server.Client(),
		Provider:            store,
		ClientVersion:       "2.4.5",
		CatalogSyncInterval: -1,
	}
	if mutateOpts != nil {
		mutateOpts(&opts)
	}
	svc, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close)
	return svc, store, dir
}

func TestCatalogSyncETag304InlinePricingAndSingleConfigRevision(t *testing.T) {
	var mu sync.Mutex
	etag := `"beeftv-cat-v1"`
	price := 0.2
	priceCatalogCalls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			mu.Lock()
			curETag := etag
			curPrice := price
			mu.Unlock()
			w.Header().Set("ETag", curETag)
			w.Header().Set(CatalogETagHeader, curETag)
			if r.Header.Get("If-None-Match") == curETag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{
						"id":                       "hy-image-v3",
						"model_type":               "image",
						"supported_endpoint_types": []string{"image-generation"},
						"pricing": map[string]any{
							"model_name":      "hy-image-v3",
							"mode":            "per_request",
							"per_request_cny": curPrice,
							"display_kind":    "image",
						},
					},
				},
			})
		case "/api/enterprise/catalog":
			mu.Lock()
			priceCatalogCalls++
			mu.Unlock()
			w.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	svc, store, _ := seedConnectedCatalogService(t, server, nil, nil)

	summary1, err := svc.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Force: true})
	if err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}
	if summary1.CatalogConfigRevision == 0 {
		t.Fatalf("expected non-zero catalogConfigRevision after initial sync")
	}
	if priceCatalogCalls != 0 {
		t.Fatalf("expected single /v1/models fetch without /api/enterprise/catalog, got %d calls", priceCatalogCalls)
	}
	if got := catalogProfile(t, store, "hy-image-v3")["pricing"].(map[string]any)["per_request_cny"]; got != 0.2 {
		t.Fatalf("unexpected inline price: %#v", got)
	}

	// Second sync hits 304 Not Modified and must not bump catalogConfigRevision.
	summary2, err := svc.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Force: true})
	if err != nil {
		t.Fatalf("304 sync failed: %v", err)
	}
	if summary2.CatalogConfigRevision != summary1.CatalogConfigRevision {
		t.Fatalf("304 bumped catalogConfigRevision: %d -> %d", summary1.CatalogConfigRevision, summary2.CatalogConfigRevision)
	}

	// Unrelated user edits bump local-model-config revision; an unchanged forced refresh does not bump catalogConfigRevision.
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	effective.Config["textModel"] = "custom::chat"
	svc.PreserveWrite(effective.Config, effective.Config)
	rawCfg, _ := json.Marshal(effective.Config)
	if err := store.SaveLocalModelConfig(rawCfg); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RefreshCatalog(context.Background()); err != nil {
		t.Fatalf("unchanged forced refresh failed: %v", err)
	}
	if got := svc.Status().CatalogConfigRevision; got != summary2.CatalogConfigRevision {
		t.Fatalf("unchanged catalog refresh bumped catalogConfigRevision: %d -> %d", summary2.CatalogConfigRevision, got)
	}

	// Price update changes ETag -> 200 OK -> catalogConfigRevision advances beyond user's edit revision and price updates.
	mu.Lock()
	etag = `"beeftv-cat-v2"`
	price = 0.45
	mu.Unlock()
	summary3, err := svc.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Force: true})
	if err != nil {
		t.Fatalf("updated sync failed: %v", err)
	}
	if summary3.CatalogConfigRevision <= summary2.CatalogConfigRevision {
		t.Fatalf("expected catalogConfigRevision to advance on price change: %d <= %d", summary3.CatalogConfigRevision, summary2.CatalogConfigRevision)
	}
	if got := catalogProfile(t, store, "hy-image-v3")["pricing"].(map[string]any)["per_request_cny"]; got != 0.45 {
		t.Fatalf("price did not update: %#v", got)
	}
}

func TestCatalogSyncPiggybackETagFromEstimatePricingTriggersSilentRefresh(t *testing.T) {
	var mu sync.Mutex
	etag := `"beeftv-cat-v1"`
	includeNewModel := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		curETag := etag
		withNew := includeNewModel
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("ETag", curETag)
			w.Header().Set(CatalogETagHeader, curETag)
			if r.Header.Get("If-None-Match") == curETag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			models := []map[string]any{
				{
					"id": "hy-image-v3", "model_type": "image", "supported_endpoint_types": []string{"image-generation"},
					"pricing": map[string]any{"model_name": "hy-image-v3", "mode": "per_request", "per_request_cny": 0.2, "display_kind": "image"},
				},
			}
			if withNew {
				models = append(models, map[string]any{
					"id": "gpt-image-2.5", "model_type": "image", "supported_endpoint_types": []string{"image-generation"},
					"pricing": map[string]any{"model_name": "gpt-image-2.5", "mode": "per_request", "per_request_cny": 0.35, "display_kind": "image"},
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
		case "/v1/pricing/estimate":
			w.Header().Set(CatalogETagHeader, curETag)
			amount := 0.2
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items":   []map[string]any{{"amount": amount, "label": "预计 ¥0.2", "basis": "¥0.2/张", "text": "预计 ¥0.2（¥0.2/张）"}},
				"summary": map[string]any{"amount": amount, "priced": 1, "unknown": 0, "text": "预计费用：¥0.2"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	svc, store, _ := seedConnectedCatalogService(t, server, nil, nil)

	before, err := svc.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Force: true})
	if err != nil {
		t.Fatal(err)
	}
	if catalogProfileOrNil(store, "gpt-image-2.5") != nil {
		t.Fatal("new model existed before update")
	}

	mu.Lock()
	etag = `"beeftv-cat-v2"`
	includeNewModel = true
	mu.Unlock()

	if _, err := svc.EstimatePricing(context.Background(), PricingEstimateRequest{
		Targets: []PricingEstimateTarget{{Model: "hy-image-v3", Kind: "image"}},
	}); err != nil {
		t.Fatalf("EstimatePricing failed: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if svc.Status().CatalogConfigRevision > before.CatalogConfigRevision && catalogProfileOrNil(store, "gpt-image-2.5") != nil {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("piggyback ETag did not trigger background catalog refresh (before=%d after=%d)", before.CatalogConfigRevision, svc.Status().CatalogConfigRevision)
}

func TestCatalogSyncClientUpgradeBypassesETagAndCooldown(t *testing.T) {
	var mu sync.Mutex
	seenIfNoneMatch := make([]string, 0)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		seenIfNoneMatch = append(seenIfNoneMatch, r.Header.Get("If-None-Match"))
		mu.Unlock()
		w.Header().Set("ETag", `"beeftv-cat-v1"`)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{
					"id": "gpt-image-2", "model_type": "image", "supported_endpoint_types": []string{"image-generation"},
					"pricing": map[string]any{"model_name": "gpt-image-2", "mode": "per_request", "per_request_cny": 0.35, "display_kind": "image"},
				},
			},
		})
	}))
	t.Cleanup(server.Close)

	svc, store, dir := seedConnectedCatalogService(t, server, nil, func(opts *Options) {
		opts.ClientVersion = "2.4.4"
	})
	if _, err := svc.RefreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := catalogProfile(t, store, "gpt-image-2")["pricing"].(map[string]any)["per_request_cny"]; got != 0.35 {
		t.Fatalf("expected initial price 0.35, got %#v", got)
	}
	svc.Close()

	mu.Lock()
	seenIfNoneMatch = nil
	mu.Unlock()
	upgraded, err := New(Options{
		DataDir: dir, Origin: server.URL, HTTPClient: server.Client(), Provider: store,
		ClientVersion: "2.4.5", CatalogSyncInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(upgraded.Close)
	if _, err := upgraded.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Cooldown: time.Hour}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seenIfNoneMatch) != 1 || seenIfNoneMatch[0] != "" {
		t.Fatalf("expected upgraded client to bypass cooldown and If-None-Match, got %#v", seenIfNoneMatch)
	}
}

func TestCatalogSyncCooldownPeriodicLoopAndVerifyRemoteShortcut(t *testing.T) {
	var modelsCalls atomic.Int32
	var mu sync.Mutex
	etag := `"beeftv-cat-v1"`
	includeSecond := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		curETag := etag
		withSecond := includeSecond
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/beeftv/connection":
			w.Header().Set(CatalogETagHeader, curETag)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"market": "enterprise", "token_id": 9, "key_name": "BeefTV",
				"catalog_etag": curETag, "account": map[string]any{"id": 42, "username": "ender"},
			})
		case "/v1/models":
			modelsCalls.Add(1)
			w.Header().Set("ETag", curETag)
			w.Header().Set(CatalogETagHeader, curETag)
			if r.Header.Get("If-None-Match") == curETag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			models := []map[string]any{
				{"id": "hy-image-v3", "model_type": "image", "supported_endpoint_types": []string{"image-generation"}},
			}
			if withSecond {
				models = append(models, map[string]any{"id": "seedance-2.5", "model_type": "video", "supported_endpoint_types": []string{"openai-video"}})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	svc, store, _ := seedConnectedCatalogService(t, server, func(st *persistedState) {
		st.CatalogETag = `"beeftv-cat-v1"`
		st.CatalogClientVersion = "2.4.5"
	}, func(opts *Options) {
		opts.CatalogSyncInterval = 300 * time.Millisecond
	})
	if err := svc.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && svc.Status().CatalogSyncing {
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := svc.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Cooldown: time.Minute}); err != nil {
		t.Fatal(err)
	}
	if calls := modelsCalls.Load(); calls != 0 {
		t.Fatalf("matching startup ETag + cooldown should avoid /v1/models fetch, got %d calls", calls)
	}

	mu.Lock()
	etag = `"beeftv-cat-v2"`
	includeSecond = true
	mu.Unlock()

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if catalogProfileOrNil(store, "seedance-2.5") != nil {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("periodic background loop did not sync new model")
}

func catalogProfileOrNil(store *workspace.ProviderConfig, id string) map[string]any {
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return nil
	}
	channel := findChannel(current.Config["channels"].([]any), ChannelID)
	if channel == nil {
		return nil
	}
	return refreshTestProfile(channel, id)
}

func TestCatalogSyncRejects200ErrorEnvelopeAndNullDataPreservingCatalog(t *testing.T) {
	var mu sync.Mutex
	mode := "ok"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		cur := mode
		mu.Unlock()
		switch cur {
		case "ok":
			w.Header().Set("ETag", `"beeftv-cat-good"`)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{
						"id": "hy-image-v3", "model_type": "image", "supported_endpoint_types": []string{"image-generation"},
						"pricing": map[string]any{"model_name": "hy-image-v3", "mode": "per_request", "per_request_cny": 0.25, "display_kind": "image"},
					},
				},
			})
		case "error200":
			w.Header().Set("ETag", `"beeftv-cat-bad"`)
			_, _ = io.WriteString(w, `{"error":{"message":"upstream maintenance"}}`)
		case "nullData":
			w.Header().Set("ETag", `"beeftv-cat-null"`)
			_, _ = io.WriteString(w, `{"data":null}`)
		}
	}))
	t.Cleanup(server.Close)

	svc, store, _ := seedConnectedCatalogService(t, server, nil, nil)
	if _, err := svc.RefreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"error200", "nullData"} {
		mu.Lock()
		mode = bad
		mu.Unlock()
		if _, err := svc.RefreshCatalog(context.Background()); err == nil {
			t.Fatalf("expected error for HTTP 200 %s response", bad)
		}
		profile := catalogProfile(t, store, "hy-image-v3")
		if got := profile["pricing"].(map[string]any)["per_request_cny"]; got != 0.25 {
			t.Fatalf("%s corrupted saved catalog price: %#v", bad, got)
		}
		if svc.state.CatalogETag != `"beeftv-cat-good"` {
			t.Fatalf("%s overwrote saved ETag with %q", bad, svc.state.CatalogETag)
		}
	}
}

func TestCatalogSyncPiggybackETagRespectsFailureBackoff(t *testing.T) {
	var modelsCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			modelsCalls.Add(1)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	now := time.Now()
	svc, _, _ := seedConnectedCatalogService(t, server, func(st *persistedState) {
		st.CatalogETag = `"old"`
		st.CatalogClientVersion = "2.4.5"
	}, func(opts *Options) {
		opts.CatalogSyncInterval = time.Minute
		opts.Now = func() time.Time { return now }
	})

	svc.NoteRemoteCatalogETag(`"new-v2"`)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && modelsCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) && svc.Status().CatalogSyncing {
		time.Sleep(5 * time.Millisecond)
	}
	if calls := modelsCalls.Load(); calls != 1 {
		t.Fatalf("expected 1 initial attempt, got %d", calls)
	}
	svc.NoteRemoteCatalogETag(`"new-v2"`)
	svc.NoteRemoteCatalogETag(`"new-v3"`)
	_, _ = svc.SyncCatalogIfNeeded(context.Background(), CatalogSyncOptions{Force: true})
	time.Sleep(40 * time.Millisecond)
	if calls := modelsCalls.Load(); calls != 1 {
		t.Fatalf("expected backoff to suppress retry storm, got %d calls", calls)
	}
}

func TestCatalogSyncRecoversFromStartupCatalogFailedAndPreservesUserConfig(t *testing.T) {
	var failFirst atomic.Bool
	failFirst.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			if failFirst.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("ETag", `"recovered-v1"`)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{
						"id": "hy-image-v3", "model_type": "image", "supported_endpoint_types": []string{"image-generation"},
						"pricing": map[string]any{"model_name": "hy-image-v3", "mode": "per_request", "per_request_cny": 0.3, "display_kind": "image"},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	svc, store, _ := seedConnectedCatalogService(t, server, func(st *persistedState) {
		st.Status = StateCatalogFailed
		st.CatalogOK = false
	}, func(opts *Options) {
		opts.CatalogSyncInterval = 25 * time.Millisecond
	})
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"my-custom","name":"MyCustom","baseUrl":"https://example.com/v1","apiFormat":"openai","models":["custom-1"]}],"imageModel":"my-custom::custom-1"}`)); err != nil {
		t.Fatal(err)
	}

	_ = svc.Recover(context.Background())
	if svc.Status().State != StateCatalogFailed {
		t.Fatalf("expected catalog_failed initially, got %s", svc.Status().State)
	}

	failFirst.Store(false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if svc.Status().State == StateConnected && catalogProfileOrNil(store, "hy-image-v3") != nil {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if svc.Status().State != StateConnected {
		t.Fatalf("periodic sync did not self-heal catalog_failed, state=%s", svc.Status().State)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if findChannel(effective.Config["channels"].([]any), "my-custom") == nil {
		t.Fatalf("atomic catalog write dropped user custom channel")
	}
}
