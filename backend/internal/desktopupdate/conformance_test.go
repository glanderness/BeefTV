package desktopupdate

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

type updateTrustConformance struct {
	KnownPlatforms      []string `json:"knownPlatforms"`
	UnknownPlatforms    []string `json:"unknownPlatforms"`
	ValidVersions       []string `json:"validVersions"`
	InvalidVersions     []string `json:"invalidVersions"`
	AllowedDownloadURLs []string `json:"allowedDownloadURLs"`
	RejectedDownloadURLs []string `json:"rejectedDownloadURLs"`
	AllowedRedirectURLs []string `json:"allowedRedirectURLs"`
	RejectedRedirectURLs []string `json:"rejectedRedirectURLs"`
}

func TestUpdateTrustConformanceMatchesDSHPlugin(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "plugins", "deepseek-harness", "update-trust-conformance.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read shared conformance fixture %s: %v", fixturePath, err)
	}
	var spec updateTrustConformance
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("parse conformance fixture: %v", err)
	}

	for _, plat := range spec.KnownPlatforms {
		if !knownPlatform(plat) {
			t.Errorf("expected knownPlatform(%q) == true", plat)
		}
	}
	for _, plat := range spec.UnknownPlatforms {
		if knownPlatform(plat) {
			t.Errorf("expected knownPlatform(%q) == false", plat)
		}
	}
	for _, ver := range spec.ValidVersions {
		if _, err := parseStableVersion(ver); err != nil {
			t.Errorf("expected valid version %q, got error: %v", ver, err)
		}
	}
	for _, ver := range spec.InvalidVersions {
		if _, err := parseStableVersion(ver); err == nil {
			t.Errorf("expected invalid version %q to fail", ver)
		}
	}
	for _, rawURL := range spec.AllowedDownloadURLs {
		if err := validateArtifactURL(rawURL, true); err != nil {
			t.Errorf("expected allowed download URL %q, got error: %v", rawURL, err)
		}
	}
	for _, rawURL := range spec.RejectedDownloadURLs {
		if err := validateArtifactURL(rawURL, true); err == nil {
			t.Errorf("expected rejected download URL %q to fail", rawURL)
		}
	}
	for _, rawURL := range spec.AllowedRedirectURLs {
		parsed, err := url.Parse(rawURL)
		if err != nil || parsed.Scheme != "https" || !isKnownRedirectHost(parsed.Hostname()) {
			t.Errorf("expected allowed redirect URL %q to pass", rawURL)
		}
	}
	for _, rawURL := range spec.RejectedRedirectURLs {
		parsed, err := url.Parse(rawURL)
		if err == nil && parsed.Scheme == "https" && isKnownRedirectHost(parsed.Hostname()) {
			t.Errorf("expected rejected redirect URL %q to fail", rawURL)
		}
	}
}
