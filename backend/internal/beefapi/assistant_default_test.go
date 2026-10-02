package beefapi

import (
	"context"
	"encoding/json"
	"infinite-canvas/backend/internal/workspace"
	"testing"
)

func TestCatalogFailureRecoveryPreservesSelectedAssistant(t *testing.T) {
	fake := &fakeEnterprise{models: []map[string]any{{"id": "gpt-6-astra", "model_type": "text"}, {"id": "claude-opus-5-5", "model_type": "text"}}}
	svc, store, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	current, _, _ := store.LoadEffectiveModelConfig()
	if current.Config["assistantModel"] != "beefapi::gpt-6-astra" {
		t.Fatal("fresh authorization default missing")
	}
	current.Config["assistantModel"] = "beefapi::claude-opus-5-5"
	body, _ := json.Marshal(current.Config)
	if err := store.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.catalogFail = true
	fake.mu.Unlock()
	if err := svc.finalizeSavedCredential(context.Background(), ""); err == nil {
		t.Fatal("expected catalog failure")
	}
	fake.mu.Lock()
	fake.catalogFail = false
	fake.mu.Unlock()
	if err := svc.finalizeSavedCredential(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	current, _, _ = store.LoadEffectiveModelConfig()
	if current.Config["assistantModel"] != "beefapi::claude-opus-5-5" {
		t.Fatal("catalog recovery overwrote user choice")
	}
}

func TestAuthorizationAssistantDefaultAndCatalogRefresh(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	models := []CatalogModel{{ID: "claude-opus-5-5", ModelType: "text", SupportedEndpointTypes: []string{"openai"}}, {ID: "gpt-6-astra", ModelType: "text", SupportedEndpointTypes: []string{"openai"}}}
	if err := applyCatalog(store, models, "", "42", true); err != nil {
		t.Fatal(err)
	}
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if current.Config["assistantModel"] != "beefapi::gpt-6-astra" {
		t.Fatal("authorization did not choose Astra")
	}
	current.Config["assistantModel"] = "beefapi::claude-opus-5-5"
	body, _ := json.Marshal(current.Config)
	if err := store.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, models, "42", "42", false); err != nil {
		t.Fatal(err)
	}
	current, _, _ = store.LoadEffectiveModelConfig()
	if current.Config["assistantModel"] != "beefapi::claude-opus-5-5" {
		t.Fatal("refresh overwrote user choice")
	}
	if err := applyCatalog(store, models[:1], "42", "42", true); err != nil {
		t.Fatal(err)
	}
	current, _, _ = store.LoadEffectiveModelConfig()
	if current.Config["assistantModel"] != "beefapi::claude-opus-5-5" {
		t.Fatal("missing fresh Astra was fabricated from cached catalog")
	}
}
