package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func TestAssistantSessionConfigAndCompactProxyContracts(t *testing.T) {
	var seenPaths []string
	var seenBodies []map[string]any
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seenPaths = append(seenPaths, r.Method+" "+r.URL.Path)
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			seenBodies = append(seenBodies, body)
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/session-config":
				_, _ = w.Write([]byte(`{"sessionId":"durable:11111111-1111-1111-1111-111111111111","thinkingLevel":"high","contextUsage":{"estimatedTokens":1200,"contextWindow":200000,"percent":1,"totalInput":1000,"totalOutput":200,"cacheRead":600,"cacheWrite":100}}`))
			case "/compact":
				if body["instructions"] == "trigger-fail" {
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = w.Write([]byte(`{"code":503,"reason":"compaction_failed"}`))
					return
				}
				_, _ = w.Write([]byte(`{"sessionId":"durable:11111111-1111-1111-1111-111111111111","compacted":true,"entryId":42,"thinkingLevel":"high","contextUsage":{"estimatedTokens":320,"contextWindow":200000,"percent":0,"totalInput":1200,"totalOutput":260,"cacheRead":600,"cacheWrite":100}}`))
			default:
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"reason":"not_found"}`))
			}
		})
	})

	// 1. 只读外部客户端禁止修改思考深度或压缩上下文。
	_, readOnlyToken, err := env.clients.Register("readonly-client", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	roHeaders := map[string]string{"X-Beeftv-Agent-Token": readOnlyToken}
	if rec := env.callWithHeaders(t, http.MethodPost, "/assistant/session-config", `{"canvasId":"`+env.canvasID+`","thinkingLevel":"high"}`, roHeaders); rec.Code != http.StatusForbidden {
		t.Fatalf("readonly session-config status = %d, want 403", rec.Code)
	}
	if rec := env.callWithHeaders(t, http.MethodPost, "/assistant/compact", `{"canvasId":"`+env.canvasID+`"}`, roHeaders); rec.Code != http.StatusForbidden {
		t.Fatalf("readonly compact status = %d, want 403", rec.Code)
	}

	// 2. 参数校验拒绝非法思考深度、非法 sessionId、过长说明与不存在画布。
	if rec := env.call(t, http.MethodPost, "/assistant/session-config", `{"canvasId":"`+env.canvasID+`","thinkingLevel":"ultra"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid thinkingLevel status = %d, want 400", rec.Code)
	}
	if rec := env.call(t, http.MethodPost, "/assistant/session-config", `{"canvasId":"`+env.canvasID+`","sessionId":"../bad","thinkingLevel":"high"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid sessionId status = %d, want 400", rec.Code)
	}
	if rec := env.call(t, http.MethodPost, "/assistant/compact", `{"canvasId":"missing-canvas"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("missing canvas status = %d, want 404", rec.Code)
	}
	tooLong := strings.Repeat("a", 4001)
	if rec := env.call(t, http.MethodPost, "/assistant/compact", `{"canvasId":"`+env.canvasID+`","instructions":"`+tooLong+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversize compact instructions status = %d, want 400", rec.Code)
	}
	if len(seenPaths) != 0 {
		t.Fatalf("invalid requests should never reach host, got %v", seenPaths)
	}

	// 3. 合法请求完整转发到宿主并透传结果。
	cfgRec := env.call(t, http.MethodPost, "/assistant/session-config", `{"canvasId":"`+env.canvasID+`","sessionId":"durable:11111111-1111-1111-1111-111111111111","thinkingLevel":"high"}`)
	if cfgRec.Code != http.StatusOK {
		t.Fatalf("session-config status = %d body=%s", cfgRec.Code, cfgRec.Body.String())
	}
	if !strings.Contains(cfgRec.Body.String(), `"thinkingLevel":"high"`) || !strings.Contains(cfgRec.Body.String(), `"cacheRead":600`) {
		t.Fatalf("unexpected session-config body: %s", cfgRec.Body.String())
	}

	compactRec := env.call(t, http.MethodPost, "/assistant/compact", `{"canvasId":"`+env.canvasID+`","sessionId":"durable:11111111-1111-1111-1111-111111111111","instructions":"保留主角服装设定"}`)
	if compactRec.Code != http.StatusOK {
		t.Fatalf("compact status = %d body=%s", compactRec.Code, compactRec.Body.String())
	}
	if !strings.Contains(compactRec.Body.String(), `"compacted":true`) || !strings.Contains(compactRec.Body.String(), `"estimatedTokens":320`) {
		t.Fatalf("unexpected compact body: %s", compactRec.Body.String())
	}
	if len(seenPaths) != 2 || seenPaths[0] != "POST /session-config" || seenPaths[1] != "POST /compact" {
		t.Fatalf("host paths = %v, want [/session-config, /compact]", seenPaths)
	}
	if seenBodies[1]["instructions"] != "保留主角服装设定" {
		t.Fatalf("compact instructions not forwarded: %#v", seenBodies[1])
	}

	// 4. 4000 个中文字符按字符数合法放行（不误按 UTF-8 字节数拦截），且宿主 compaction_failed 原因原样透传。
	chinese4000 := strings.Repeat("镜", 4000)
	if rec := env.call(t, http.MethodPost, "/assistant/compact", `{"canvasId":"`+env.canvasID+`","instructions":"`+chinese4000+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("4000 chinese runes should pass, got status=%d body=%s", rec.Code, rec.Body.String())
	}
	failRec := env.call(t, http.MethodPost, "/assistant/compact", `{"canvasId":"`+env.canvasID+`","instructions":"trigger-fail"}`)
	if failRec.Code != http.StatusServiceUnavailable || !strings.Contains(failRec.Body.String(), `"reason":"compaction_failed"`) {
		t.Fatalf("compaction_failed passthrough failed: status=%d body=%s", failRec.Code, failRec.Body.String())
	}
}
