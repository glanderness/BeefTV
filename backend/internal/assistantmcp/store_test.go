package assistantmcp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func strPtr(s string) *string    { return &s }
func boolPtr(b bool) *bool       { return &b }
func intPtr(n int) *int          { return &n }
func slicePtr(s ...string) *[]string { return &s }

func TestStoreUpsertEncryptsSecretsAndRedactsViews(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	httpView, err := store.Upsert(UpsertInput{
		Name:      "exa",
		Transport: "streamable-http",
		URL:       strPtr("https://mcp.exa.ai/mcp"),
		Headers: map[string]string{
			"Authorization": "Bearer secret-token-123",
			"X-App":         "BeefTV",
		},
		TimeoutSec: intPtr(45),
	})
	if err != nil {
		t.Fatalf("Upsert http failed: %v", err)
	}
	if httpView.Transport != "http" || !httpView.Enabled || httpView.TimeoutSec != 45 {
		t.Fatalf("unexpected http view: %+v", httpView)
	}
	if len(httpView.HeaderKeys) != 2 || httpView.HeaderKeys[0] != "Authorization" || httpView.HeaderKeys[1] != "X-App" {
		t.Fatalf("unexpected header keys: %+v", httpView.HeaderKeys)
	}

	stdioView, err := store.Upsert(UpsertInput{
		Name:      "local-fs",
		Transport: "stdio",
		Enabled:   boolPtr(false),
		Command:   strPtr("npx"),
		Args:      slicePtr("-y", "@modelcontextprotocol/server-filesystem", "."),
		Env: map[string]string{
			"API_TOKEN": "top-secret-env",
			"LOG_LEVEL": "info",
		},
	})
	if err != nil {
		t.Fatalf("Upsert stdio failed: %v", err)
	}
	if stdioView.Transport != "stdio" || stdioView.Enabled {
		t.Fatalf("unexpected stdio view: %+v", stdioView)
	}

	// File permissions and on-disk encryption check.
	filePath := filepath.Join(dir, configFileName)
	info, err := os.Stat(filePath)
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("expected 0600 mode, got %o", info.Mode().Perm())
	}
	rawDisk, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if strings.Contains(string(rawDisk), "secret-token-123") || strings.Contains(string(rawDisk), "top-secret-env") {
		t.Fatalf("plaintext secret leaked to disk: %s", string(rawDisk))
	}

	// Runtime view returns only enabled servers with decrypted secrets.
	enabled, fp1, err := store.ListEnabledRuntime()
	if err != nil {
		t.Fatalf("ListEnabledRuntime failed: %v", err)
	}
	if len(enabled) != 1 || enabled[0].Name != "exa" || enabled[0].Headers["Authorization"] != "Bearer secret-token-123" {
		t.Fatalf("unexpected enabled runtime: %+v", enabled)
	}

	// Updating timeout without resending headers preserves existing secrets; removeHeaders deletes specific keys.
	updated, err := store.Upsert(UpsertInput{
		Name:          "exa",
		TimeoutSec:    intPtr(60),
		RemoveHeaders: []string{"X-App"},
	})
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if len(updated.HeaderKeys) != 1 || updated.HeaderKeys[0] != "Authorization" {
		t.Fatalf("expected Authorization kept and X-App removed, got %+v", updated.HeaderKeys)
	}
	enabled2, fp2, err := store.ListEnabledRuntime()
	if err != nil {
		t.Fatalf("ListEnabledRuntime after update failed: %v", err)
	}
	if enabled2[0].Headers["Authorization"] != "Bearer secret-token-123" {
		t.Fatalf("secret was lost on partial update: %+v", enabled2[0].Headers)
	}
	if fp1 == fp2 {
		t.Fatalf("expected fingerprint to change after update")
	}

	// Delete removes the entry.
	if err := store.Delete("local-fs"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}
	views, err := store.ListViews()
	if err != nil || len(views) != 1 || views[0].Name != "exa" {
		t.Fatalf("unexpected views after delete: %+v, err=%v", views, err)
	}
}

func TestValidateRejectsUnsafeConfigs(t *testing.T) {
	cases := []ServerConfig{
		{Name: "bad name!", Transport: "http", URL: "https://example.com/mcp"},
		{Name: "metadata", Transport: "http", URL: "http://169.254.169.254/latest/meta-data"},
		{Name: "legacy-sse", Transport: "sse", URL: "https://example.com/sse"},
		{Name: "userinfo", Transport: "http", URL: "https://user:pass@example.com/mcp"},
		{Name: "empty-cmd", Transport: "stdio", Command: ""},
		{Name: "reserved-env", Transport: "stdio", Command: "node", Env: map[string]string{"BEEFTV_AGENT_HOST_TOKEN": "leak"}},
		{Name: "non-ascii-header", Transport: "http", URL: "https://example.com/mcp", Headers: map[string]string{"X-Title": "牛肉"}},
		{Name: "host-override", Transport: "http", URL: "https://example.com/mcp", Headers: map[string]string{"Host": "evil.com"}},
	}
	for _, tc := range cases {
		cfg := tc
		if err := ValidateServerConfig(&cfg); err == nil {
			t.Fatalf("expected ValidateServerConfig(%q) to fail", tc.Name)
		}
	}
}
