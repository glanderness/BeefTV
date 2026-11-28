package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantMandatesRejectAgentAndHostTokens(t *testing.T) {
	env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
	})
	client, clientToken, err := env.clients.RegisterClient("mcp", "external-agent", agentops.ClientReadWrite, agentops.ClientApprovalAuto)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	mandate, err := operations.CreateProductionMandateInTx(env.service.Database(), owner.ID, operations.CreateProductionMandateInput{
		CanvasID:     env.canvasID,
		MaxAmountCNY: 30,
		ApprovedBy:   "ui",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := operations.UpsertToolApprovalInTx(env.service.Database(), owner.ID, operations.ToolApprovalRecord{
		ProposalID:    "ap-auth-test",
		CanvasID:      env.canvasID,
		SessionID:     "durable:00000000-0000-0000-0000-000000000010",
		TurnID:        "turn-auth",
		DurableTaskID: 42,
		ToolName:      "canvas_generation_submit",
		Status:        operations.ToolApprovalStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	routes := []struct {
		path string
		body string
	}{
		{"/api/assistant/mandates", `{"canvasId":"` + env.canvasID + `","maxAmountCny":50}`},
		{"/api/assistant/mandates/" + mandate.ID + "/revoke", `{}`},
		{"/api/assistant/approvals/ap-auth-test/decide", `{"canvasId":"` + env.canvasID + `","decision":"approve"}`},
	}

	for _, tc := range routes {
		// 1. Registered external agent token (X-Beeftv-Client) MUST be rejected with 403 agent_token_cannot_approve.
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.RemoteAddr = "127.0.0.1:43210"
		req.Host = "127.0.0.1:8080"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Beeftv-Client", client.ID)
		req.Header.Set("Authorization", "Bearer "+clientToken)
		rec := httptest.NewRecorder()
		env.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"agent_token_cannot_approve"`) {
			t.Fatalf("external client on %s: expected 403 agent_token_cannot_approve, got %d %s", tc.path, rec.Code, rec.Body.String())
		}

		// 2. Built-in assistant host token (X-Beeftv-Agent-Token) MUST also be rejected with 403 agent_token_cannot_approve.
		req2 := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req2.RemoteAddr = "127.0.0.1:43210"
		req2.Host = "127.0.0.1:8080"
		req2.Header.Set("Content-Type", "application/json")
		req2.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
		rec2 := httptest.NewRecorder()
		env.router.ServeHTTP(rec2, req2)
		if rec2.Code != http.StatusForbidden || !strings.Contains(rec2.Body.String(), `"agent_token_cannot_approve"`) {
			t.Fatalf("host token on %s: expected 403 agent_token_cannot_approve, got %d %s", tc.path, rec2.Code, rec2.Body.String())
		}
	}
}

func TestAssistantMandatesOwnerLifecycleAndApprovalSignalDispatch(t *testing.T) {
	var receivedSignals []map[string]any
	env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/signals" && r.Method == http.MethodPost {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				receivedSignals = append(receivedSignals, body)
				_, _ = w.Write([]byte(`{"ok":true,"result":"delivered"}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
	})
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	sessionID := "durable:00000000-0000-0000-0000-000000000020"
	if err := env.service.Database().Create(&model.AssistantTurn{
		TurnID: "turn-signal-1", UserID: owner.ID, CanvasID: env.canvasID, DurableSessionID: sessionID, State: "open", PermissionMode: "canvas",
	}).Error; err != nil {
		t.Fatalf("open turn failed: %v", err)
	}

	// 1. Host calls /assistant/runtime/tool-precheck for media.review -> gets approval_required and persists record.
	precheckBody, _ := json.Marshal(map[string]any{
		"canvasId":      env.canvasID,
		"sessionId":     sessionID,
		"turnId":        "turn-signal-1",
		"durableTaskId": 77,
		"toolName":      "media_review",
		"opName":        "media.review",
		"callId":        "call-rev-1",
		"params":        map[string]any{"canvasId": env.canvasID, "mode": "video"},
	})
	preReq := httptest.NewRequest(http.MethodPost, "/api/assistant/runtime/tool-precheck", bytes.NewReader(precheckBody))
	preReq.RemoteAddr = "127.0.0.1:43210"
	preReq.Host = "127.0.0.1:8080"
	preReq.Header.Set("Content-Type", "application/json")
	preReq.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
	preRec := httptest.NewRecorder()
	env.router.ServeHTTP(preRec, preReq)
	if preRec.Code != http.StatusOK {
		t.Fatalf("tool-precheck failed: %d %s", preRec.Code, preRec.Body.String())
	}
	var preResp struct {
		Data operations.ToolPrecheckResult `json:"data"`
	}
	if err := json.Unmarshal(preRec.Body.Bytes(), &preResp); err != nil {
		t.Fatal(err)
	}
	if preResp.Data.Decision != "approval_required" || preResp.Data.ProposalID == "" {
		t.Fatalf("expected approval_required with proposalId, got %+v", preResp.Data)
	}

	// 2. Owner UI approves WITH a new ProductionMandate -> persists to SQLite and dispatches POST /signals.
	decideBody, _ := json.Marshal(map[string]any{
		"canvasId": env.canvasID,
		"decision": "approve",
		"createMandate": map[string]any{
			"canvasId":         env.canvasID,
			"sessionId":        sessionID,
			"maxAmountCny":     50,
			"maxUnquotedCount": 5,
		},
	})
	decReq := httptest.NewRequest(http.MethodPost, "/api/assistant/approvals/"+preResp.Data.ProposalID+"/decide", bytes.NewReader(decideBody))
	decReq.RemoteAddr = "127.0.0.1:43210"
	decReq.Host = "127.0.0.1:8080"
	decReq.Header.Set("Content-Type", "application/json")
	decReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	decRec := httptest.NewRecorder()
	env.router.ServeHTTP(decRec, decReq)
	if decRec.Code != http.StatusOK {
		t.Fatalf("approval decide failed: %d %s", decRec.Code, decRec.Body.String())
	}
	var decResp struct {
		Data struct {
			Signaled bool                             `json:"signaled"`
			Mandate  operations.ProductionMandateView `json:"mandate"`
		} `json:"data"`
	}
	if err := json.Unmarshal(decRec.Body.Bytes(), &decResp); err != nil {
		t.Fatal(err)
	}
	if !decResp.Data.Signaled || decResp.Data.Mandate.ID == "" || decResp.Data.Mandate.MaxAmountCNY != 50 {
		t.Fatalf("unexpected decide response: %+v", decResp.Data)
	}
	if len(receivedSignals) != 1 || receivedSignals[0]["signal"] != "approval_decision" || receivedSignals[0]["key"] != preResp.Data.ProposalID {
		t.Fatalf("expected 1 approval_decision signal, got %+v", receivedSignals)
	}

	// 3. Re-running tool-precheck now returns allow under the active mandate!
	preReq2 := httptest.NewRequest(http.MethodPost, "/api/assistant/runtime/tool-precheck", bytes.NewReader(precheckBody))
	preReq2.RemoteAddr = "127.0.0.1:43210"
	preReq2.Host = "127.0.0.1:8080"
	preReq2.Header.Set("Content-Type", "application/json")
	preReq2.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
	preRec2 := httptest.NewRecorder()
	env.router.ServeHTTP(preRec2, preReq2)
	var preResp2 struct {
		Data operations.ToolPrecheckResult `json:"data"`
	}
	_ = json.Unmarshal(preRec2.Body.Bytes(), &preResp2)
	if preResp2.Data.Decision != "allow" {
		t.Fatalf("expected allow after approval+mandate, got %+v", preResp2.Data)
	}

	// 4. Owner lists mandates -> must include non-null activeMandate!
	listReq := httptest.NewRequest(http.MethodGet, "/api/assistant/mandates?canvasId="+env.canvasID+"&sessionId="+sessionID, nil)
	listReq.RemoteAddr = "127.0.0.1:43210"
	listReq.Host = "127.0.0.1:8080"
	listReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	listRec := httptest.NewRecorder()
	env.router.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list mandates failed: %d %s", listRec.Code, listRec.Body.String())
	}
	var listResp struct {
		Data struct {
			Mandates      []operations.ProductionMandateView `json:"mandates"`
			ActiveMandate *operations.ProductionMandateView  `json:"activeMandate"`
		} `json:"data"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResp); err != nil {
		t.Fatal(err)
	}
	if listResp.Data.ActiveMandate == nil || listResp.Data.ActiveMandate.ID != decResp.Data.Mandate.ID {
		t.Fatalf("expected activeMandate=%s in GET /assistant/mandates, got %+v", decResp.Data.Mandate.ID, listResp.Data.ActiveMandate)
	}

	revReq := httptest.NewRequest(http.MethodPost, "/api/assistant/mandates/"+decResp.Data.Mandate.ID+"/revoke", strings.NewReader(`{}`))
	revReq.RemoteAddr = "127.0.0.1:43210"
	revReq.Host = "127.0.0.1:8080"
	revReq.Header.Set("Content-Type", "application/json")
	revReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	revRec := httptest.NewRecorder()
	env.router.ServeHTTP(revRec, revReq)
	if revRec.Code != http.StatusOK || !strings.Contains(revRec.Body.String(), `"status":"revoked"`) {
		t.Fatalf("revoke mandate failed: %d %s", revRec.Code, revRec.Body.String())
	}

	// After revoke, GET /assistant/mandates must return activeMandate: null.
	listReq2 := httptest.NewRequest(http.MethodGet, "/api/assistant/mandates?canvasId="+env.canvasID+"&sessionId="+sessionID, nil)
	listReq2.RemoteAddr = "127.0.0.1:43210"
	listReq2.Host = "127.0.0.1:8080"
	listReq2.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	listRec2 := httptest.NewRecorder()
	env.router.ServeHTTP(listRec2, listReq2)
	var listResp2 struct {
		Data struct {
			ActiveMandate *operations.ProductionMandateView `json:"activeMandate"`
		} `json:"data"`
	}
	if err := json.Unmarshal(listRec2.Body.Bytes(), &listResp2); err != nil {
		t.Fatal(err)
	}
	if listResp2.Data.ActiveMandate != nil {
		t.Fatalf("expected activeMandate=null after revoke, got %+v", listResp2.Data.ActiveMandate)
	}

	// 5. Cancelling an open turn with a pending approval clears pendingApprovals from /assistant/history!
	if err := env.service.Database().Create(&model.AssistantTurn{
		TurnID: "turn-cancel-apv", UserID: owner.ID, CanvasID: env.canvasID, DurableSessionID: sessionID, State: "open", PermissionMode: "canvas",
	}).Error; err != nil {
		t.Fatal(err)
	}
	cancelPreBody, _ := json.Marshal(map[string]any{
		"canvasId": env.canvasID, "sessionId": sessionID, "turnId": "turn-cancel-apv",
		"durableTaskId": 88, "toolName": "media_review", "opName": "media.review",
		"callId": "call-cancel-1", "params": map[string]any{"canvasId": env.canvasID, "mode": "video"},
	})
	cpReq := httptest.NewRequest(http.MethodPost, "/api/assistant/runtime/tool-precheck", bytes.NewReader(cancelPreBody))
	cpReq.RemoteAddr = "127.0.0.1:43210"
	cpReq.Host = "127.0.0.1:8080"
	cpReq.Header.Set("Content-Type", "application/json")
	cpReq.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
	cpRec := httptest.NewRecorder()
	env.router.ServeHTTP(cpRec, cpReq)
	if cpRec.Code != http.StatusOK {
		t.Fatalf("precheck before cancel failed: %d %s", cpRec.Code, cpRec.Body.String())
	}
	cancelReq := httptest.NewRequest(http.MethodPost, "/api/assistant/cancel", strings.NewReader(`{"canvasId":"`+env.canvasID+`"}`))
	cancelReq.RemoteAddr = "127.0.0.1:43210"
	cancelReq.Host = "127.0.0.1:8080"
	cancelReq.Header.Set("Content-Type", "application/json")
	cancelReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	cancelRec := httptest.NewRecorder()
	env.router.ServeHTTP(cancelRec, cancelReq)
	if cancelRec.Code != http.StatusOK {
		t.Fatalf("cancel failed: %d %s", cancelRec.Code, cancelRec.Body.String())
	}
	histReq := httptest.NewRequest(http.MethodGet, "/api/assistant/history?canvasId="+env.canvasID, nil)
	histReq.RemoteAddr = "127.0.0.1:43210"
	histReq.Host = "127.0.0.1:8080"
	histReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	histRec := httptest.NewRecorder()
	env.router.ServeHTTP(histRec, histReq)
	var histResp struct {
		Data struct {
			PendingApprovals []operations.ToolApprovalRecord `json:"pendingApprovals"`
		} `json:"data"`
	}
	if err := json.Unmarshal(histRec.Body.Bytes(), &histResp); err != nil {
		t.Fatal(err)
	}
	if len(histResp.Data.PendingApprovals) != 0 {
		t.Fatalf("expected pendingApprovals=[] after cancel, got %+v", histResp.Data.PendingApprovals)
	}
}
