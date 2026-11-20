package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestTaskOutcomeReadEndpointsOnlyAddPublicProjection(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	op := "canvas:outcome-receipt"
	conclusion := "unrecoverable"
	task := model.Task{ID: "outcome-task", UserID: owner.ID, ProjectID: "outcome-canvas", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", ClientOperationID: &op, RecoveryOutcome: &conclusion, InputJSON: `{"mode":"image","config":{"apiKey":"never-expose"},"metadata":{"nodeId":"n1"}}`}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/tasks/" + task.ID, "/api/tasks/by-operation/" + op + "?projectId=" + task.ProjectID, "/api/tasks?projectId=" + task.ProjectID} {
		t.Run(path, func(t *testing.T) {
			resp := h.do(t, http.MethodGet, path, nil)
			if resp.Code != 200 {
				t.Fatalf("%d %s", resp.Code, resp.Body.String())
			}
			if strings.Contains(resp.Body.String(), "never-expose") || strings.Contains(resp.Body.String(), "recovery_outcome") {
				t.Fatal("泄露私有事实或凭据")
			}
			var env struct {
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
				t.Fatal(err)
			}
			var got model.Task
			if strings.HasPrefix(strings.TrimSpace(string(env.Data)), "[") {
				var items []model.Task
				if err := json.Unmarshal(env.Data, &items); err != nil || len(items) != 1 {
					t.Fatalf("list=%s err=%v", env.Data, err)
				}
				got = items[0]
			} else if err := json.Unmarshal(env.Data, &got); err != nil {
				t.Fatal(err)
			}
			if got.ID != task.ID || got.Status != model.TaskStatusFailed || got.Outcome == nil || got.Outcome.Phase != "failed" || got.Outcome.Regenerate != "confirm" || got.Outcome.Reason != "result_unrecoverable" {
				t.Fatalf("投影=%+v", got)
			}
		})
	}
	stored, err := h.svc.Task(owner.ID, task.ID)
	if err != nil || stored.Status != task.Status {
		t.Fatal("读接口改了任务")
	}
}

func TestTaskRecoverEndpointRecoversAndNeverCreatesOrIncrementsRouteRun(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}

	var queries, creates atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		queries.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"vid-upstream-1","status":"failed","error":{"message":"upstream failed"}}`))
	}))
	defer upstream.Close()

	future := time.Now().Add(10 * time.Minute)
	inputJSON, _ := json.Marshal(map[string]any{
		"mode": "video",
		"config": map[string]any{
			"baseUrl":   upstream.URL,
			"apiKey":    "secret-key",
			"apiFormat": "openai",
			"model":     "seedance-2.0-mini",
		},
	})
	videoTask := model.Task{
		ID:                "recover-video-endpoint",
		UserID:            owner.ID,
		ProjectID:         "outcome-canvas",
		Type:              "canvas_video",
		Model:             "seedance-2.0-mini",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "vid-upstream-1",
		RouteRun:          2,
		NextPollAt:        &future,
		InputJSON:         string(inputJSON),
	}
	if err := h.db.Create(&videoTask).Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodPost, "/api/tasks/"+videoTask.ID+"/recover", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Data.ID != videoTask.ID || env.Data.Outcome == nil || env.Data.Outcome.Phase != "failed" || env.Data.Outcome.Reason != "no_result" {
		t.Fatalf("unexpected recover outcome: %+v outcome=%+v", env.Data, env.Data.Outcome)
	}
	var storedVideo model.Task
	if err := h.db.First(&storedVideo, "id = ?", videoTask.ID).Error; err != nil || storedVideo.RouteRun != 2 {
		t.Fatalf("stored video RouteRun=%d err=%v", storedVideo.RouteRun, err)
	}
	if queries.Load() != 1 || creates.Load() != 0 {
		t.Fatalf("queries=%d creates=%d", queries.Load(), creates.Load())
	}
	var totalTasks int64
	h.db.Model(&model.Task{}).Count(&totalTasks)
	if totalTasks != 1 {
		t.Fatalf("expected 1 task in DB, got %d", totalTasks)
	}
}

func TestActiveOnlyTasksEndpointIncludesOutcomeActiveTasksBeyondFirstPage(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	unrecoverable := "unrecoverable"
	seed := []model.Task{
		{
			ID:         "old-succeeded-retrievable",
			UserID:     owner.ID,
			ProjectID:  "active-canvas",
			Type:       "canvas_image",
			Status:     model.TaskStatusSucceeded,
			Stage:      "delivery_paused",
			ResultJSON: `{"images":[{"url":"https://example.invalid/img.png"}]}`,
			CreatedAt:  base,
			UpdatedAt:  base,
		},
		{
			ID:                "old-failed-retrievable",
			UserID:            owner.ID,
			ProjectID:         "active-canvas",
			Type:              "canvas_video",
			Status:            model.TaskStatusFailed,
			Stage:             "任务失败",
			ProviderRequestID: "synthetic-upstream-video-1",
			CreatedAt:         base.Add(time.Second),
			UpdatedAt:         base.Add(time.Second),
		},
		{
			ID:        "old-failed-log-retrievable",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusFailed,
			Stage:     "任务失败",
			CreatedAt: base.Add(1500 * time.Millisecond),
			UpdatedAt: base.Add(1500 * time.Millisecond),
		},
		{
			ID:        "old-cancelled-log-retrievable",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			CreatedAt: base.Add(1800 * time.Millisecond),
			UpdatedAt: base.Add(1800 * time.Millisecond),
		},
		{
			ID:        "old-cancelled-plain",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			CreatedAt: base.Add(1900 * time.Millisecond),
			UpdatedAt: base.Add(1900 * time.Millisecond),
		},
		{
			ID:              "old-failed-terminal",
			UserID:          owner.ID,
			ProjectID:       "active-canvas",
			Type:            "canvas_image",
			Status:          model.TaskStatusFailed,
			Stage:           "任务失败",
			RecoveryOutcome: &unrecoverable,
			CreatedAt:       base.Add(2 * time.Second),
			UpdatedAt:       base.Add(2 * time.Second),
		},
		{
			ID:        "old-running",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_image",
			Status:    model.TaskStatusRunning,
			Stage:     "生成中",
			CreatedAt: base.Add(3 * time.Second),
			UpdatedAt: base.Add(3 * time.Second),
		},
	}
	var readyResults []model.Result
	for i := 0; i < 60; i++ {
		stamp := base.Add(time.Duration(10+i) * time.Second)
		taskID := fmt.Sprintf("ready-img-%d", i)
		seed = append(seed, model.Task{
			ID:         taskID,
			UserID:     owner.ID,
			ProjectID:  "active-canvas",
			Type:       "canvas_image",
			Status:     model.TaskStatusSucceeded,
			Stage:      "生成完成",
			ResultJSON: `{"images":[{"url":"https://example.invalid/ready.png"}]}`,
			CreatedAt:  stamp,
			UpdatedAt:  stamp,
		})
		readyResults = append(readyResults, model.Result{
			ID:        fmt.Sprintf("res-img-%d", i),
			UserID:    owner.ID,
			TaskID:    taskID,
			Kind:      "generation_output",
			Payload:   `{"outputIndex":0,"mediaType":"image","providerArtifactRef":"https://example.invalid/ready.png","materializedAssetId":"asset-ready-1"}`,
			CreatedAt: stamp,
		})
	}
	for i := 0; i < 2045; i++ {
		stamp := base.Add(time.Duration(100+i) * time.Second)
		seed = append(seed, model.Task{
			ID:        fmt.Sprintf("plain-fail-%d", i),
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusFailed,
			Stage:     "任务失败",
			CreatedAt: stamp,
			UpdatedAt: stamp,
		})
	}
	for i := 0; i < 5; i++ {
		stamp := base.Add(time.Duration(3000+i) * time.Second)
		seed = append(seed, model.Task{
			ID:         fmt.Sprintf("ready-text-%d", i),
			UserID:     owner.ID,
			ProjectID:  "active-canvas",
			Type:       "canvas_text",
			Status:     model.TaskStatusSucceeded,
			Stage:      "已完成",
			ResultJSON: `{"text":"done"}`,
			CreatedAt:  stamp,
			UpdatedAt:  stamp,
		})
	}
	if err := h.db.CreateInBatches(&seed, 100).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.db.CreateInBatches(&readyResults, 100).Error; err != nil {
		t.Fatal(err)
	}
	logs := []model.ApiCallLog{
		{
			ID:                "log-old-failed-retrievable",
			UserID:            owner.ID,
			TaskID:            "old-failed-log-retrievable",
			Capability:        "video",
			RequestKind:       "create",
			Method:            http.MethodPost,
			Status:            model.ApiCallStatusSucceeded,
			ProviderRequestID: "synthetic-upstream-video-2",
			CreatedAt:         base.Add(1500 * time.Millisecond),
		},
		{
			ID:                "log-old-cancelled-retrievable",
			UserID:            owner.ID,
			TaskID:            "old-cancelled-log-retrievable",
			Capability:        "video",
			RequestKind:       "create",
			Method:            http.MethodPost,
			Status:            model.ApiCallStatusSucceeded,
			ProviderRequestID: "synthetic-upstream-video-3",
			CreatedAt:         base.Add(1800 * time.Millisecond),
		},
	}
	if err := h.db.Create(&logs).Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodGet, "/api/tasks?projectId=active-canvas&pageSize=100&activeOnly=true", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data []model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	gotIDs := make([]string, 0, len(env.Data))
	for _, item := range env.Data {
		gotIDs = append(gotIDs, item.ID)
	}
	wantIDs := []string{"old-running", "old-failed-log-retrievable", "old-failed-retrievable", "old-succeeded-retrievable"}
	if strings.Join(gotIDs, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("activeOnly ids=%v, want %v", gotIDs, wantIDs)
	}

	detailResp := h.do(t, http.MethodGet, "/api/tasks/old-cancelled-log-retrievable", nil)
	if detailResp.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", detailResp.Code, detailResp.Body.String())
	}
	var detailEnv struct {
		Data model.Task `json:"data"`
	}
	if err := json.Unmarshal(detailResp.Body.Bytes(), &detailEnv); err != nil {
		t.Fatal(err)
	}
	wantOutcome := model.TaskOutcome{Phase: "failed", Regenerate: "confirm", Reason: "cancelled_result_unconfirmed"}
	if detailEnv.Data.Outcome == nil || *detailEnv.Data.Outcome != wantOutcome {
		t.Fatalf("cancelled detail outcome=%+v, want %+v", detailEnv.Data.Outcome, wantOutcome)
	}
}

func TestActiveOnlyTasksEndpointRetainsCancelledTaskWhenEvidenceUnreadable(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	noResult := "no_result"
	unrecoverable := "unrecoverable"
	tasks := []model.Task{
		{
			ID:        "cancelled-unreadable",
			UserID:    owner.ID,
			ProjectID: "unreadable-canvas",
			Type:      "canvas_image",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			CreatedAt: now,
			UpdatedAt: now,
		},
		{
			ID:              "cancelled-terminal-unreadable",
			UserID:          owner.ID,
			ProjectID:       "unreadable-canvas",
			Type:            "canvas_video",
			Status:          model.TaskStatusCancelled,
			Stage:           "任务已取消",
			RecoveryOutcome: &noResult,
			CreatedAt:       now.Add(time.Second),
			UpdatedAt:       now.Add(time.Second),
		},
		{
			ID:              "failed-terminal-unreadable",
			UserID:          owner.ID,
			ProjectID:       "unreadable-canvas",
			Type:            "canvas_image",
			Status:          model.TaskStatusFailed,
			Stage:           "任务失败",
			RecoveryOutcome: &unrecoverable,
			CreatedAt:       now.Add(2 * time.Second),
			UpdatedAt:       now.Add(2 * time.Second),
		},
	}
	if err := h.db.Create(&tasks).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.db.Exec("DROP TABLE route_attempts").Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodGet, "/api/tasks?projectId=unreadable-canvas&pageSize=20&activeOnly=true", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data []model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	gotIDs := make([]string, 0, len(env.Data))
	wantOutcome := model.TaskOutcome{Phase: "retrievable", Regenerate: "blocked", Reason: "evidence_unavailable"}
	for _, item := range env.Data {
		gotIDs = append(gotIDs, item.ID)
		if item.Outcome == nil || *item.Outcome != wantOutcome {
			t.Fatalf("unreadable task %s outcome=%+v, want %+v", item.ID, item.Outcome, wantOutcome)
		}
	}
	wantIDs := []string{"failed-terminal-unreadable", "cancelled-terminal-unreadable", "cancelled-unreadable"}
	if strings.Join(gotIDs, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("activeOnly unreadable ids=%v, want %v", gotIDs, wantIDs)
	}
}

func TestTaskRegenerateEndpointCreatesFreshTaskForCancelledAcceptedImageAndUpscale(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beeftv","baseUrl":"https://beeftv.app","apiKey":"synthetic-disk-key","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	canvas := model.CanvasProject{
		ID:          "regen-canvas",
		UserID:      owner.ID,
		Title:       "regen",
		PayloadJSON: `{"nodes":[],"connections":[]}`,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	sourceRes := model.Resource{
		ID:        "owned-upscale-src",
		UserID:    owner.ID,
		Kind:      "image",
		MimeType:  "image/png",
		ObjectKey: "owned-upscale-src.png",
		Status:    model.ResourceStatusReady,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := h.db.Create(&sourceRes).Error; err != nil {
		t.Fatal(err)
	}

	// 1. Cancelled canvas_image with accepted dispatch + ImageSubmission receipt:
	// /retry MUST stay rejected by ValidateImageTaskRetry, while /regenerate creates a brand-new task.
	imgInputJSON, _ := json.Marshal(map[string]any{
		"mode":   "image",
		"prompt": "a red fox in snow",
		"config": map[string]any{
			"baseUrl": "https://api.example.com/v1",
			"apiKey":  "sk-test-byok",
			"model":   "gpt-image-1",
		},
		"metadata": map[string]any{
			"nodeId":            "node-img-1",
			"clientOperationId": "orig:cancelled-img-1",
			"retryOf":           "older-task-1",
		},
	})
	oldOp := "orig:cancelled-img-1"
	cancelledImg := model.Task{
		ID:                "cancelled-accepted-img",
		UserID:            owner.ID,
		ProjectID:         canvas.ID,
		Type:              "canvas_image",
		Status:            model.TaskStatusCancelled,
		Stage:             "任务已取消",
		Prompt:            "a red fox in snow",
		Provider:          "openai-compatible",
		Model:             "gpt-image-1",
		RouteRun:          1,
		ClientOperationID: &oldOp,
		InputJSON:         string(imgInputJSON),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := h.db.Create(&cancelledImg).Error; err != nil {
		t.Fatal(err)
	}
	attempt := model.RouteAttempt{
		ID:            "attempt-cancelled-img-1",
		TaskID:        cancelledImg.ID,
		RouteRun:      1,
		AttemptNumber: 1,
		Status:        "dispatching",
		DispatchState: "accepted",
		StartedAt:     now,
	}
	if err := h.db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	submission := model.ImageSubmission{
		AttemptID:        attempt.ID,
		TaskID:           cancelledImg.ID,
		UserID:           owner.ID,
		SendCount:        1,
		ResponseAccepted: true,
		CreatedAt:        now,
	}
	if err := h.db.Create(&submission).Error; err != nil {
		t.Fatal(err)
	}

	retryResp := h.do(t, http.MethodPost, "/api/tasks/"+cancelledImg.ID+"/retry", nil)
	if retryResp.Code != http.StatusBadRequest {
		t.Fatalf("expected /retry to remain blocked by image idempotency guard, got %d body=%s", retryResp.Code, retryResp.Body.String())
	}

	regenResp := h.do(t, http.MethodPost, "/api/tasks/"+cancelledImg.ID+"/regenerate", map[string]any{"clientOperationId": "regen:cancelled-img-1"})
	if regenResp.Code != http.StatusOK {
		t.Fatalf("cancelled image /regenerate status=%d body=%s", regenResp.Code, regenResp.Body.String())
	}
	var regenEnv struct {
		Data model.Task `json:"data"`
	}
	if err := json.Unmarshal(regenResp.Body.Bytes(), &regenEnv); err != nil {
		t.Fatal(err)
	}
	if regenEnv.Data.ID == "" || regenEnv.Data.ID == cancelledImg.ID || regenEnv.Data.Status != model.TaskStatusQueued {
		t.Fatalf("unexpected regenerated image task: %+v", regenEnv.Data)
	}
	// Idempotent replay with the same clientOperationId returns the same newly created task.
	replayResp := h.do(t, http.MethodPost, "/api/tasks/"+cancelledImg.ID+"/regenerate", map[string]any{"clientOperationId": "regen:cancelled-img-1"})
	if replayResp.Code != http.StatusOK {
		t.Fatalf("idempotent /regenerate status=%d body=%s", replayResp.Code, replayResp.Body.String())
	}
	var replayEnv struct {
		Data model.Task `json:"data"`
	}
	if err := json.Unmarshal(replayResp.Body.Bytes(), &replayEnv); err != nil {
		t.Fatal(err)
	}
	if replayEnv.Data.ID != regenEnv.Data.ID {
		t.Fatalf("idempotent /regenerate minted second task %s != %s", replayEnv.Data.ID, regenEnv.Data.ID)
	}
	var originalStored model.Task
	if err := h.db.First(&originalStored, "id = ?", cancelledImg.ID).Error; err != nil || originalStored.Status != model.TaskStatusCancelled {
		t.Fatalf("original cancelled image task was mutated: %+v err=%v", originalStored, err)
	}

	// 2. Cancelled upscale (canvas_image + topaz-standard-v2) with ProviderRequestID:
	// /regenerate succeeds and creates a brand-new queued upscale task.
	upscaleInputJSON, _ := json.Marshal(map[string]any{
		"mode":   "image",
		"prompt": "AI 超分",
		"config": map[string]any{
			"credentialRef": "beeftv",
			"apiKey":        "synthetic-disk-key",
			"baseUrl":       "https://beeftv.app",
			"model":         "topaz-standard-v2",
			"interfaceType": "newapi",
		},
		"upscale":         map[string]any{"factor": 2},
		"referenceImages": []any{map[string]any{"storageKey": "resource:" + sourceRes.ID}},
		"metadata":        map[string]any{"nodeId": "node-upscale-1"},
	})
	cancelledUpscale := model.Task{
		ID:                "cancelled-upscale-1",
		UserID:            owner.ID,
		ProjectID:         canvas.ID,
		Type:              "canvas_image",
		Operation:         "media.upscale.topaz",
		Status:            model.TaskStatusCancelled,
		Stage:             "任务已取消",
		Prompt:            "AI 超分",
		Provider:          "beeftv",
		Model:             "topaz-standard-v2",
		ProviderRequestID: "upscale-req-cancelled-1",
		InputJSON:         string(upscaleInputJSON),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := h.db.Create(&cancelledUpscale).Error; err != nil {
		t.Fatal(err)
	}
	upscaleRegenResp := h.do(t, http.MethodPost, "/api/tasks/"+cancelledUpscale.ID+"/regenerate", map[string]any{"clientOperationId": "regen:cancelled-upscale-1"})
	if upscaleRegenResp.Code != http.StatusOK {
		t.Fatalf("cancelled upscale /regenerate status=%d body=%s", upscaleRegenResp.Code, upscaleRegenResp.Body.String())
	}
	var upscaleEnv struct {
		Data model.Task `json:"data"`
	}
	if err := json.Unmarshal(upscaleRegenResp.Body.Bytes(), &upscaleEnv); err != nil {
		t.Fatal(err)
	}
	if upscaleEnv.Data.ID == "" || upscaleEnv.Data.ID == cancelledUpscale.ID || upscaleEnv.Data.Status != model.TaskStatusQueued || upscaleEnv.Data.Model != "topaz-standard-v2" {
		t.Fatalf("unexpected regenerated upscale task: %+v", upscaleEnv.Data)
	}

	// 3. Blocked settlement_pending task must be rejected by /regenerate.
	pendingUsage := "pending"
	blockedTask := model.Task{
		ID:             "cancelled-settlement-pending",
		UserID:         owner.ID,
		ProjectID:      canvas.ID,
		Type:           "canvas_image",
		Status:         model.TaskStatusCancelled,
		Stage:          "任务已取消",
		Prompt:         "blocked",
		Model:          "gpt-image-1",
		BeefUsageState: &pendingUsage,
		InputJSON:      string(imgInputJSON),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := h.db.Create(&blockedTask).Error; err != nil {
		t.Fatal(err)
	}
	blockedResp := h.do(t, http.MethodPost, "/api/tasks/"+blockedTask.ID+"/regenerate", nil)
	if blockedResp.Code != http.StatusBadRequest {
		t.Fatalf("expected settlement_pending /regenerate to be rejected, got %d body=%s", blockedResp.Code, blockedResp.Body.String())
	}
}
