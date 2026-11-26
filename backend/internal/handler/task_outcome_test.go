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
	"infinite-canvas/backend/internal/repository"
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

func TestActiveOnlySQLPreFilterSkipsHistoricalTerminalTasks(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	noResult := "no_result"
	unrecoverable := "unrecoverable"
	settled := "settled"
	completed := "completed"
	var batch []model.Task
	for i := 0; i < 200; i++ {
		ts := now.Add(time.Duration(i) * time.Millisecond)
		batch = append(batch,
			model.Task{
				ID:                fmt.Sprintf("hist-cancelled-%03d", i),
				UserID:            owner.ID,
				ProjectID:         "scale-canvas",
				Type:              "canvas_image",
				Status:            model.TaskStatusCancelled,
				Stage:             "任务已取消",
				ProviderRequestID: fmt.Sprintf("prov-cancel-%03d", i),
				CreatedAt:         ts,
				UpdatedAt:         ts,
			},
			model.Task{
				ID:              fmt.Sprintf("hist-failed-terminal-%03d", i),
				UserID:          owner.ID,
				ProjectID:       "scale-canvas",
				Type:            "canvas_video",
				Status:          model.TaskStatusFailed,
				Stage:           "任务失败",
				RecoveryOutcome: &noResult,
				CreatedAt:       ts,
				UpdatedAt:       ts,
			},
			model.Task{
				ID:               fmt.Sprintf("hist-failed-charged-%03d", i),
				UserID:           owner.ID,
				ProjectID:        "scale-canvas",
				Type:             "canvas_image",
				Status:           model.TaskStatusFailed,
				Stage:            "任务失败",
				RecoveryOutcome:  &unrecoverable,
				BeefUsageState:   &completed,
				BeefBillingState: &settled,
				CreatedAt:        ts,
				UpdatedAt:        ts,
			},
		)
	}
	batch = append(batch,
		model.Task{
			ID:                "active-failed-retrievable",
			UserID:            owner.ID,
			ProjectID:         "scale-canvas",
			Type:              "canvas_video",
			Status:            model.TaskStatusFailed,
			Stage:             "任务失败",
			ProviderRequestID: "prov-retrievable-1",
			CreatedAt:         now.Add(time.Second),
			UpdatedAt:         now.Add(time.Second),
		},
		model.Task{
			ID:         "active-succeeded-delivery",
			UserID:     owner.ID,
			ProjectID:  "scale-canvas",
			Type:       "canvas_image",
			Status:     model.TaskStatusSucceeded,
			Stage:      "生成完成",
			ResultJSON: `{"images":[{"url":"https://example.invalid/pending.png"}]}`,
			CreatedAt:  now.Add(2 * time.Second),
			UpdatedAt:  now.Add(2 * time.Second),
		},
		model.Task{
			ID:        "active-queued",
			UserID:    owner.ID,
			ProjectID: "scale-canvas",
			Type:      "canvas_image",
			Status:    model.TaskStatusQueued,
			Stage:     "等待队列调度",
			CreatedAt: now.Add(3 * time.Second),
			UpdatedAt: now.Add(3 * time.Second),
		},
	)
	if err := h.db.CreateInBatches(&batch, 100).Error; err != nil {
		t.Fatal(err)
	}

	candidates, err := repository.New(h.db).ActiveCandidateTasksAfter(owner.ID, "scale-canvas", nil, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 3 {
		t.Fatalf("SQL active candidates = %d, want 3 (600 historical terminal rows must be filtered in SQL)", len(candidates))
	}

	resp := h.do(t, http.MethodGet, "/api/tasks?projectId=scale-canvas&pageSize=20&activeOnly=true", nil)
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
	wantIDs := []string{"active-queued", "active-succeeded-delivery", "active-failed-retrievable"}
	if strings.Join(gotIDs, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("activeOnly ids=%v, want %v", gotIDs, wantIDs)
	}
}

func TestActiveOnlyEvidenceUnreadablePrioritizesOlderActiveTasksAndDetectsMissingColumn(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-time.Hour)
	noResult := "no_result"
	// Seed an older genuinely queued task followed by 60 newer terminal/cancelled rows.
	seed := []model.Task{
		{
			ID:        "older-active-queued",
			UserID:    owner.ID,
			ProjectID: "degraded-canvas",
			Type:      "canvas_image",
			Status:    model.TaskStatusQueued,
			Stage:     "等待队列调度",
			CreatedAt: base,
			UpdatedAt: base,
		},
	}
	for i := 0; i < 60; i++ {
		ts := base.Add(time.Duration(i+1) * time.Second)
		seed = append(seed, model.Task{
			ID:              fmt.Sprintf("newer-cancelled-%02d", i),
			UserID:          owner.ID,
			ProjectID:       "degraded-canvas",
			Type:            "canvas_image",
			Status:          model.TaskStatusCancelled,
			Stage:           "任务已取消",
			RecoveryOutcome: &noResult,
			CreatedAt:       ts,
			UpdatedAt:       ts,
		})
	}
	if err := h.db.CreateInBatches(&seed, 100).Error; err != nil {
		t.Fatal(err)
	}
	// Replace route_attempts with a corrupted table missing dispatch_state (table exists, required column missing).
	if err := h.db.Exec("DROP TABLE route_attempts").Error; err != nil {
		t.Fatal(err)
	}
	if err := h.db.Exec("CREATE TABLE route_attempts (id TEXT PRIMARY KEY, task_id TEXT)").Error; err != nil {
		t.Fatal(err)
	}
	if repository.New(h.db).EvidenceReadable() {
		t.Fatal("EvidenceReadable() = true when route_attempts is missing dispatch_state column, want false")
	}

	resp := h.do(t, http.MethodGet, "/api/tasks?projectId=degraded-canvas&pageSize=10&activeOnly=true", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data []model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data) != 10 {
		t.Fatalf("activeOnly degraded len=%d, want bounded pageSize=10", len(env.Data))
	}
	// The older genuinely queued task must be prioritized first instead of being crowded out by newer terminal rows.
	if env.Data[0].ID != "older-active-queued" {
		t.Fatalf("first activeOnly degraded item = %s, want older-active-queued", env.Data[0].ID)
	}
	if env.Data[1].Outcome == nil || env.Data[1].Outcome.Reason != "evidence_unavailable" {
		t.Fatalf("second activeOnly degraded item outcome = %+v, want evidence_unavailable", env.Data[1].Outcome)
	}
}

func TestActiveOnlyEvidenceProbeDetectsMissingAttemptNumberAndCallLogUserIDAndSurfacesOlderCancelledBeyondSucceeded(t *testing.T) {
	cases := []struct {
		name     string
		breakSQL []string
	}{
		{
			name: "missing route_attempts.attempt_number",
			breakSQL: []string{
				"DROP TABLE route_attempts",
				"CREATE TABLE route_attempts (id TEXT PRIMARY KEY, task_id TEXT, route_run INTEGER, channel_id TEXT, dispatch_state TEXT, started_at DATETIME)",
			},
		},
		{
			name: "missing api_call_logs.user_id",
			breakSQL: []string{
				"DROP TABLE api_call_logs",
				"CREATE TABLE api_call_logs (id TEXT PRIMARY KEY, task_id TEXT, capability TEXT, request_kind TEXT, method TEXT, status TEXT, provider_request_id TEXT, created_at DATETIME)",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newRetiredAgentHarness(t)
			owner, err := h.svc.WorkspaceOwner("local")
			if err != nil {
				t.Fatal(err)
			}
			base := time.Now().UTC().Add(-time.Hour)
			noResult := "no_result"
			seed := []model.Task{
				{
					ID:              "older-cancelled-evidence",
					UserID:          owner.ID,
					ProjectID:       "probe-canvas",
					Type:            "canvas_image",
					Status:          model.TaskStatusCancelled,
					Stage:           "任务已取消",
					RecoveryOutcome: &noResult,
					CreatedAt:       base,
					UpdatedAt:       base,
				},
			}
			for i := 0; i < 60; i++ {
				ts := base.Add(time.Duration(i+1) * time.Second)
				seed = append(seed, model.Task{
					ID:         fmt.Sprintf("newer-succeeded-text-%02d", i),
					UserID:     owner.ID,
					ProjectID:  "probe-canvas",
					Type:       "canvas_text",
					Status:     model.TaskStatusSucceeded,
					Stage:      "已完成",
					ResultJSON: `{"text":"ok"}`,
					CreatedAt:  ts,
					UpdatedAt:  ts,
				})
			}
			if err := h.db.CreateInBatches(&seed, 100).Error; err != nil {
				t.Fatal(err)
			}
			for _, stmt := range tc.breakSQL {
				if err := h.db.Exec(stmt).Error; err != nil {
					t.Fatal(err)
				}
			}
			if repository.New(h.db).EvidenceReadable() {
				t.Fatalf("EvidenceReadable() = true for %s, want false", tc.name)
			}
			resp := h.do(t, http.MethodGet, "/api/tasks?projectId=probe-canvas&pageSize=10&activeOnly=true", nil)
			if resp.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
			}
			var env struct {
				Data []model.Task `json:"data"`
			}
			if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
				t.Fatal(err)
			}
			if len(env.Data) != 1 || env.Data[0].ID != "older-cancelled-evidence" {
				t.Fatalf("activeOnly degraded data = %+v, want [older-cancelled-evidence]", env.Data)
			}
			if env.Data[0].Outcome == nil || env.Data[0].Outcome.Reason != "evidence_unavailable" {
				t.Fatalf("outcome = %+v, want evidence_unavailable", env.Data[0].Outcome)
			}
		})
	}
}

func TestActiveOnlyImageSubmissionsUnreadableSurfacesAttemptedImageWithinBoundedFallback(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-time.Hour)
	seed := []model.Task{
		{
			ID:        "attempted-cancelled-image",
			UserID:    owner.ID,
			ProjectID: "img-sub-canvas",
			Type:      "canvas_image",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			RouteRun:  1,
			CreatedAt: base,
			UpdatedAt: base,
		},
	}
	// 110 newer cancelled text tasks without route attempts sit ahead of the image task
	// (page 1 skips 100 non-attempt rows; page 2 hits attempted-cancelled-image within the 2-page budget).
	for i := 0; i < 110; i++ {
		ts := base.Add(time.Duration(i+1) * time.Second)
		seed = append(seed, model.Task{
			ID:        fmt.Sprintf("non-attempt-text-%03d", i),
			UserID:    owner.ID,
			ProjectID: "img-sub-canvas",
			Type:      "canvas_text",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			CreatedAt: ts,
			UpdatedAt: ts,
		})
	}
	if err := h.db.CreateInBatches(&seed, 100).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.db.Create(&model.RouteAttempt{
		ID:            "attempt-img-1",
		TaskID:        "attempted-cancelled-image",
		RouteRun:      1,
		AttemptNumber: 1,
		Status:        "selected",
		DispatchState: "accepted",
		StartedAt:     base,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Drop ONLY image_submissions: tasks without route attempts do not query image_submissions,
	// while attempted-cancelled-image does and fails closed to evidence_unavailable.
	if err := h.db.Exec("DROP TABLE image_submissions").Error; err != nil {
		t.Fatal(err)
	}
	if repository.New(h.db).EvidenceReadable() {
		t.Fatal("EvidenceReadable() = true when image_submissions table is missing, want false")
	}

	resp := h.do(t, http.MethodGet, "/api/tasks?projectId=img-sub-canvas&pageSize=20&activeOnly=true", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data []model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range env.Data {
		if item.ID == "attempted-cancelled-image" {
			found = true
			if item.Outcome == nil || item.Outcome.Reason != "evidence_unavailable" {
				t.Fatalf("attempted image outcome = %+v, want evidence_unavailable", item.Outcome)
			}
		}
	}
	if !found {
		t.Fatalf("expected attempted-cancelled-image in activeOnly response, got %d items", len(env.Data))
	}
}

func TestCanvasAllActiveTasksCountsPastPageLimit(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	rows := make([]model.Task, 110)
	for i := range rows {
		rows[i] = model.Task{ID: fmt.Sprintf("active-count-%03d", i), UserID: owner.ID, ProjectID: "busy-canvas", Type: "canvas_video", Status: model.TaskStatusQueued, CreatedAt: now.Add(time.Duration(i) * time.Second)}
	}
	if err := h.db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	response := h.do(t, http.MethodGet, "/api/tasks?projectId=busy-canvas&pageSize=30&activeOnly=true&allActive=true", nil)
	var body struct {
		Data []model.Task `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); response.Code != 200 || err != nil || len(body.Data) != len(rows) {
		t.Fatalf("status=%d total=%d err=%v", response.Code, len(body.Data), err)
	}
}
