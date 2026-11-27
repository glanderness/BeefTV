package skills

import (
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/skillhub"
)

func TestMarketTokenAcceptsLegacyOfficialBeefTVAppEndpoint(t *testing.T) {
	svc := &Service{dataDir: t.TempDir()}
	client, err := skillhub.New(skillhub.DefaultURL)
	if err != nil {
		t.Fatalf("skillhub.New: %v", err)
	}
	authFile := filepath.Join(svc.marketUserDir("owner"), "authorization.json")

	// Existing publisher token issued against legacy https://beeftv.app continues working under default https://beeftv.cn.
	if err := writeMarketJSON(authFile, marketAuth{
		Endpoint:    "https://beeftv.app/api/beeftv/skillhub/v1",
		AccessToken: "btvpub_legacy_token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("writeMarketJSON legacy: %v", err)
	}
	got, err := svc.marketToken("owner", client)
	if err != nil || got != "btvpub_legacy_token" {
		t.Fatalf("expected legacy official token to remain valid, got (%q, %v)", got, err)
	}

	// Non-official endpoint token must still be rejected.
	if err := writeMarketJSON(authFile, marketAuth{
		Endpoint:    "https://evil.example/api/beeftv/skillhub/v1",
		AccessToken: "btvpub_untrusted_token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("writeMarketJSON untrusted: %v", err)
	}
	if _, err := svc.marketToken("owner", client); err == nil {
		t.Fatal("expected non-official endpoint token to be rejected")
	}
}
