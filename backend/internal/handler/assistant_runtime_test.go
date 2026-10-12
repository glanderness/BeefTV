package handler

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestAssistantMcpServersRequiresHostAndFiltersInvalid(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	body := `{"mcpServers":[` +
		`{"id":"local","name":"Local","enabled":true,"transport":"stdio","command":"node","args":["x.js"],"env":[{"id":"e","name":"TOKEN","value":"clear-secret"}]},` +
		`{"id":"remote","name":"Remote","enabled":true,"transport":"http","url":"https://mcp.example.test/mcp","headers":[{"id":"h","name":"Authorization","value":"header-secret"}]},` +
		`{"id":"off","name":"Off","enabled":false,"transport":"stdio","command":"node"},` +
		`{"id":"bad-stdio","name":"Bad","enabled":true,"transport":"stdio"},` +
		`{"id":"bad-url","name":"BadUrl","enabled":true,"transport":"http","url":"file:///etc/passwd"}]}`
	if err := env.service.SaveLocalModelConfig([]byte(body)); err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken}
	if got := env.call(t, http.MethodGet, "/assistant/runtime/mcp-servers", ""); got.Code != http.StatusForbidden {
		t.Fatalf("UI obtained the mcp server list: %d", got.Code)
	}

	listed := env.callWithHeaders(t, http.MethodGet, "/assistant/runtime/mcp-servers", "", headers)
	envelope := decodeEnvelope(t, listed)
	servers, _ := envelope["servers"].([]any)
	ids := make([]string, 0, len(servers))
	for _, raw := range servers {
		if item, ok := raw.(map[string]any); ok {
			ids = append(ids, item["id"].(string))
		}
	}
	if !reflect.DeepEqual(ids, []string{"local", "remote"}) {
		t.Fatalf("enabled valid servers = %v", ids)
	}
	// 宿主进程拿到明文密钥；浏览器那条路径已经在上面被拒绝。
	for _, secret := range []string{"clear-secret", "header-secret"} {
		if !strings.Contains(listed.Body.String(), secret) {
			t.Fatalf("host listing dropped %s", secret)
		}
	}

	all := decodeEnvelope(t, env.callWithHeaders(t, http.MethodGet, "/assistant/runtime/mcp-servers?includeDisabled=1", "", headers))
	allServers, _ := all["servers"].([]any)
	if len(allServers) != 3 {
		t.Fatalf("includeDisabled servers = %d", len(allServers))
	}
}

func TestRuntimeLifecycleRequiresHostAndFencesStoppedTurn(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turnID = "aabbccdd00112233"
	env.beginTurn(t, turnID, assistantTurnInput(nil, nil))
	path := "/assistant/runtime/turns/" + turnID
	if got := env.call(t, http.MethodGet, path, ""); got.Code != http.StatusForbidden {
		t.Fatalf("UI obtained host lifecycle capability: %d", got.Code)
	}
	headers := map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken}
	state := decodeEnvelope(t, env.callWithHeaders(t, http.MethodGet, path, "", headers))
	if state["open"] != true || state["canvasId"] != env.canvasID {
		t.Fatalf("bad resumable state %#v", state)
	}
	for range 2 {
		state = decodeEnvelope(t, env.callWithHeaders(t, http.MethodPost, path+"/complete", "{}", headers))
		if state["open"] != false {
			t.Fatalf("completion not idempotent %#v", state)
		}
	}
	if status, _ := env.opsRaw("canvas.node.update", "after-stop", turnID, `{"canvasId":"`+env.canvasID+`","nodeId":"n1","expectedRevision":1,"patch":{"title":"must not write"}}`); status != http.StatusForbidden {
		t.Fatalf("stopped turn still writable: %d", status)
	}
	if got := env.callWithHeaders(t, http.MethodGet, "/assistant/runtime/turns/deadbeef", "", headers); got.Code != http.StatusForbidden {
		t.Fatalf("unknown task admitted %d", got.Code)
	}
}

func TestTerminalLineRequiresMatchingBusinessTurn(t *testing.T) {
	for _, line := range []string{`{"type":"turn_end"}`, `{"type":"turn_end","turnId":"foreign"}`, `{"type":"text_delta","turnId":"owned"}`} {
		if assistantTerminalLine([]byte(line), "owned") {
			t.Fatalf("false completion %s", line)
		}
	}
	if !assistantTerminalLine([]byte(`{"type":"turn_end","turnId":"owned"}`), "owned") {
		t.Fatal("completion receipt rejected")
	}
}
