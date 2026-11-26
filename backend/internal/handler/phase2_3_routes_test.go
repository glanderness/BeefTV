package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestPhase23AssistantSettingsAutoConfirmAndForkProxy(t *testing.T) {
	forkedCalled := false
	env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/sessions/fork" {
				forkedCalled = true
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"sessionId":"durable:22222222-2222-2222-2222-222222222222","conversationId":2,"turnCount":1}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
	})

	// PATCH autoConfirmMaxCny via UI session.
	res := env.call(t, http.MethodPatch, "/assistant/settings", `{"autoConfirmMaxCny":5}`)
	if res.Code != http.StatusOK {
		t.Fatalf("PATCH /assistant/settings failed: %d %s", res.Code, res.Body.String())
	}
	res = env.call(t, http.MethodGet, "/assistant/settings", "")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"autoConfirmMaxCny":5`) {
		t.Fatalf("GET /assistant/settings did not persist autoConfirmMaxCny: %d %s", res.Code, res.Body.String())
	}

	// Out-of-range autoConfirmMaxCny rejected cleanly.
	res = env.call(t, http.MethodPatch, "/assistant/settings", `{"autoConfirmMaxCny":999}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for >50 autoConfirmMaxCny, got %d %s", res.Code, res.Body.String())
	}

	// POST /assistant/sessions/fork validates session/turn and forwards to host.
	badRes := env.call(t, http.MethodPost, "/assistant/sessions/fork", `{"canvasId":"`+env.canvasID+`","sessionId":"bad!","turnId":"t1"}`)
	if badRes.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid sessionId, got %d %s", badRes.Code, badRes.Body.String())
	}
	forkRes := env.call(t, http.MethodPost, "/assistant/sessions/fork", `{"canvasId":"`+env.canvasID+`","sessionId":"durable:11111111-1111-1111-1111-111111111111","turnId":"turn-1"}`)
	if forkRes.Code != http.StatusOK || !forkedCalled {
		t.Fatalf("expected 200 and host fork call, got %d called=%v body=%s", forkRes.Code, forkedCalled, forkRes.Body.String())
	}
	var payload struct {
		Data struct {
			SessionID      string `json:"sessionId"`
			ConversationID int    `json:"conversationId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(forkRes.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.SessionID != "durable:22222222-2222-2222-2222-222222222222" || payload.Data.ConversationID != 2 {
		t.Fatalf("unexpected fork payload: %+v", payload.Data)
	}
}

func TestPhase23GuardrailsAndCreativeBibleRoutes(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	api := env.router.Group("/api")
	repo := repository.New(env.service.Database())
	RegisterMCPActivity(api, repo, owner.ID, env.service, func(*http.Request) bool { return true })
	RegisterCreativeBibleRoutes(api, env.service)

	// 1. Guardrails GET/PUT + invalid mode rejection.
	rec := env.call(t, http.MethodGet, "/agent-clients/guardrails", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"mode":"allow"`) {
		t.Fatalf("GET /agent-clients/guardrails failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = env.call(t, http.MethodPut, "/agent-clients/guardrails", `{"mode":"propose_only","maxPerCallCny":8,"dailyBudgetCny":30}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"mode":"propose_only"`) || !strings.Contains(rec.Body.String(), `"maxPerCallCny":8`) {
		t.Fatalf("PUT /agent-clients/guardrails failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = env.call(t, http.MethodPut, "/agent-clients/guardrails", `{"mode":"bogus"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid guardrail mode, got %d %s", rec.Code, rec.Body.String())
	}

	// 2. Creative Bible shared between Project and its Canvas + optimistic revision CAS.
	db := env.service.Database()
	proj := model.Project{ID: "proj-bible-1", UserID: owner.ID, Name: "长片测试项目"}
	if err := db.Create(&proj).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ?", env.canvasID, owner.ID).Update("project_id", proj.ID).Error; err != nil {
		t.Fatal(err)
	}

	// Save via project route.
	saveReq := httptest.NewRequest(http.MethodPut, "/api/projects/"+proj.ID+"/creative-bible", strings.NewReader(`{"expectedRevision":0,"title":"霓虹雨夜","visualStyle":"35mm 胶片","characters":[{"name":"林雾","appearance":"黑色短发"}]}`))
	saveReq.Header.Set("Content-Type", "application/json")
	saveRec := httptest.NewRecorder()
	env.router.ServeHTTP(saveRec, saveReq)
	if saveRec.Code != http.StatusOK || !strings.Contains(saveRec.Body.String(), `"revision":1`) || !strings.Contains(saveRec.Body.String(), `"scopeKind":"project"`) {
		t.Fatalf("PUT /projects/:id/creative-bible failed: %d %s", saveRec.Code, saveRec.Body.String())
	}

	// Read back via canvas route -> must resolve to the SAME project bible.
	getReq := httptest.NewRequest(http.MethodGet, "/api/canvas-projects/"+env.canvasID+"/creative-bible", nil)
	getRec := httptest.NewRecorder()
	env.router.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK || !strings.Contains(getRec.Body.String(), `"scopeKind":"project"`) || !strings.Contains(getRec.Body.String(), "霓虹雨夜") || !strings.Contains(getRec.Body.String(), "林雾") {
		t.Fatalf("GET /canvas-projects/:id/creative-bible did not share project bible: %d %s", getRec.Code, getRec.Body.String())
	}

	// Stale expectedRevision via canvas route -> 409 conflict.
	staleReq := httptest.NewRequest(http.MethodPut, "/api/canvas-projects/"+env.canvasID+"/creative-bible", strings.NewReader(`{"expectedRevision":0,"title":"过期版本"}`))
	staleReq.Header.Set("Content-Type", "application/json")
	staleRec := httptest.NewRecorder()
	env.router.ServeHTTP(staleRec, staleReq)
	if staleRec.Code != http.StatusConflict {
		t.Fatalf("expected 409 conflict for stale revision, got %d %s", staleRec.Code, staleRec.Body.String())
	}
}
