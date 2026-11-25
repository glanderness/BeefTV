package beeftv

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type brandTransport func(*http.Request) (*http.Response, error)

func (f brandTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestBrandUpgradePreservesEncryptedIssuerAndRedactsUI(t *testing.T) {
	for _, origin := range []string{ProductionOrigin, LegacyProductionOrigin} {
		t.Run(origin, func(t *testing.T) {
			t.Setenv(TestOriginEnv, "")
			dir := t.TempDir()
			encrypted, err := encryptSecret(dir, "upgrade-secret")
			if err != nil {
				t.Fatal(err)
			}
			if err := saveState(dir, persistedState{Status: StateConnected, EncryptedAPIKey: encrypted, ProviderBaseURL: origin, Acked: true, CatalogOK: true}); err != nil {
				t.Fatal(err)
			}
			var requested, opened string
			svc, err := New(Options{DataDir: dir, OpenURL: func(url string) error { opened = url; return nil }, HTTPClient: &http.Client{Transport: brandTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/api/enterprise/catalog" {
					t.Errorf("unexpected legacy price catalog request: %s", r.URL.String())
					return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
				}
				requested = r.URL.String()
				if r.Method != http.MethodPost && r.Header.Get("Authorization") != "Bearer upgrade-secret" {
					t.Error("missing backend credential")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"data":[]}`)), Header: make(http.Header)}, nil
			})}})
			if err != nil {
				t.Fatal(err)
			}
			defer svc.Close()
			credential, err := svc.Resolve()
			if err != nil || credential.APIKey != "upgrade-secret" || credential.BaseURL != origin {
				t.Fatalf("credential migration: %#v %v", credential, err)
			}
			if _, err := svc.fetchModels(credential.APIKey); err != nil {
				t.Fatal(err)
			}
			if requested != origin+"/v1/models" {
				t.Fatalf("issuer changed: %s", requested)
			}
			config := svc.RedactConfig(map[string]any{"channels": []any{map[string]any{"id": ChannelID, "apiKey": "upgrade-secret", "baseUrl": ProductionOrigin}}})
			body, _ := json.Marshal(config)
			if strings.Contains(string(body), "upgrade-secret") || !strings.Contains(string(body), origin) {
				t.Fatalf("unsafe UI projection: %s", body)
			}
			if err := svc.OpenWallet(); err != nil {
				t.Fatal(err)
			}
			if opened != origin+WalletPath {
				t.Fatalf("wallet = %s", opened)
			}
			if gotSummaryWallet := svc.Status().WalletURL; gotSummaryWallet != origin+WalletPath {
				t.Fatalf("summary wallet = %s, want %s", gotSummaryWallet, origin+WalletPath)
			}
			reloaded, err := loadState(dir)
			if err != nil || reloaded.EncryptedAPIKey != encrypted {
				t.Fatal("upgrade rewrote encrypted credential")
			}
			if _, err := svc.Disconnect(context.Background()); err != nil {
				t.Fatal(err)
			}
			if requested != origin+"/v1/beeftv/connection" {
				t.Fatalf("revoke issuer = %s", requested)
			}
			// The empty device response intentionally stops before polling.
			_, _ = svc.Start(context.Background())
			if requested != ProductionOrigin+"/api/oauth/device/code" {
				t.Fatalf("new authorization origin = %s", requested)
			}
		})
	}
}

func TestSavedOriginsRejectCrossOriginAndRestoreLegacyPending(t *testing.T) {
	for _, origin := range []string{ProductionOrigin, LegacyProductionOrigin} {
		if got, err := savedOrigin(persistedState{Device: &persistedDevice{VerificationURI: origin + "/desktop-auth"}}, ProductionOrigin); err != nil || got != origin {
			t.Fatalf("pending origin = %s %v", got, err)
		}
		if _, err := CanonicalOrigin(origin); err != nil {
			t.Fatal(err)
		}
	}
	for _, origin := range []string{"https://legacy-enterprise.example.com", "https://legacy.example.com", "https://beeftv.app.evil.test", "http://beeftv.app", "https://beeftv.app:8443", "https://evil.test", "https://user@beeftv.app"} {
		if _, err := savedOrigin(persistedState{ProviderBaseURL: origin}, ProductionOrigin); err == nil {
			t.Fatalf("trusted saved origin %s", origin)
		}
		if _, err := CanonicalOrigin(origin); err == nil {
			t.Fatalf("trusted canonical origin %s", origin)
		}
	}
	if _, err := savedOrigin(persistedState{AuthorizationOrigin: ProductionOrigin, ProviderBaseURL: "https://evil.test"}, ProductionOrigin); err == nil {
		t.Fatal("accepted mismatched provider")
	}
}
