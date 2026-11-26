package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAssistantMCPRoutesAuthAndRedaction(t *testing.T) {
	env := newAssistantTestEnv(t, nil)

	// Unauthenticated UI read must be rejected.
	res := env.callWithHeaders(t, http.MethodGet, "/assistant/mcp-servers", "", map[string]string{})
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without UI session, got %d: %s", res.Code, res.Body.String())
	}

	// Runtime endpoint must reject UI sessions without host token.
	res = env.call(t, http.MethodGet, "/assistant/runtime/mcp-servers", "")
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on runtime endpoint for UI session, got %d: %s", res.Code, res.Body.String())
	}

	// Save an HTTP MCP server via UI session.
	saveBody := `{"name":"exa","transport":"http","url":"https://mcp.exa.ai/mcp","headers":{"Authorization":"Bearer top-secret-key"}}`
	res = env.call(t, http.MethodPut, "/assistant/mcp-servers/exa", saveBody)
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200 saving MCP server, got %d: %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "top-secret-key") {
		t.Fatalf("save response leaked secret header: %s", res.Body.String())
	}

	// List via UI session must redact secret values and expose only headerKeys.
	res = env.call(t, http.MethodGet, "/assistant/mcp-servers", "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200 listing MCP servers, got %d: %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "top-secret-key") {
		t.Fatalf("list response leaked secret header: %s", res.Body.String())
	}

	// Host token can read decrypted config via /assistant/runtime/mcp-servers.
	res = env.callWithHeaders(t, http.MethodGet, "/assistant/runtime/mcp-servers", "", map[string]string{
		"X-Beeftv-Agent-Token": assistantTestHostToken,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200 for host runtime read, got %d: %s", res.Code, res.Body.String())
	}
	var rtEnv struct {
		Data struct {
			Fingerprint string `json:"fingerprint"`
			Servers     []struct {
				Name    string            `json:"name"`
				Headers map[string]string `json:"headers"`
			} `json:"servers"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &rtEnv); err != nil {
		t.Fatalf("unmarshal runtime response failed: %v", err)
	}
	if len(rtEnv.Data.Servers) != 1 || rtEnv.Data.Servers[0].Headers["Authorization"] != "Bearer top-secret-key" {
		t.Fatalf("expected decrypted header in host runtime response, got %+v", rtEnv.Data)
	}

	// Delete removes the server.
	res = env.call(t, http.MethodDelete, "/assistant/mcp-servers/exa", "")
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200 deleting MCP server, got %d: %s", res.Code, res.Body.String())
	}
}
