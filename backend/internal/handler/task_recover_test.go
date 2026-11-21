package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

func TestTaskRecoverEndpointReturnsClear502OnDownloadConnectionDrop(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}

	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				_ = conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	}))
	defer mediaServer.Close()

	resultJSON, err := json.Marshal(map[string]any{
		"video": map[string]any{"url": mediaServer.URL + "/output.mp4?signature=secret-recover-token"},
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID:         "recover-eof-http",
		UserID:     owner.ID,
		ProjectID:  "recover-canvas",
		Type:       "canvas_video",
		Status:     model.TaskStatusSucceeded,
		Stage:      model.TaskStageFetchingResult,
		ResultJSON: string(resultJSON),
		InputJSON:  `{"mode":"video","config":{"model":"seedance-2.0"}}`,
	}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodPost, "/api/tasks/"+task.ID+"/recover", nil)
	if resp.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Code   int    `json:"code"`
		Reason string `json:"reason"`
		Msg    string `json:"msg"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Code != http.StatusBadGateway || env.Reason != "bad_gateway" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
	if env.Msg != outbound.ResumableConnectionDropMessage {
		t.Fatalf("msg = %q, want %q", env.Msg, outbound.ResumableConnectionDropMessage)
	}
	if strings.Contains(resp.Body.String(), "secret-recover-token") || strings.Contains(resp.Body.String(), mediaServer.URL) {
		t.Fatalf("response leaked signed URL: %s", resp.Body.String())
	}
}

func TestTaskRecoverEndpointReturns409WhileDeliveryIsStopping(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", "1024")
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		select {
		case <-started:
		default:
			close(started)
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))

	resultJSON, err := json.Marshal(map[string]any{
		"images": []any{map[string]any{"url": mediaServer.URL + "/image.png"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID:         "recover-stopping-http",
		UserID:     owner.ID,
		ProjectID:  "recover-canvas",
		Type:       "canvas_image",
		Status:     model.TaskStatusSucceeded,
		Stage:      model.TaskStageFetchingResult,
		ResultJSON: string(resultJSON),
		InputJSON:  `{"mode":"image","config":{"model":"test-image"}}`,
	}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	deliverDone := make(chan error, 1)
	go func() {
		deliverDone <- h.svc.DeliverSucceededTask(task)
	}()
	defer func() {
		close(release)
		mediaServer.Close()
		select {
		case <-deliverDone:
		case <-time.After(5 * time.Second):
		}
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("background delivery download did not start")
	}

	// 模拟下载处于暂停/正在停止窗口：stage=delivery_paused 且原下载句柄尚未释放。
	if err := h.db.Model(&model.Task{}).Where("id = ?", task.ID).Update("stage", "delivery_paused").Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodPost, "/api/tasks/"+task.ID+"/recover", nil)
	if resp.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Code   int    `json:"code"`
		Reason string `json:"reason"`
		Msg    string `json:"msg"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Code != http.StatusConflict || env.Reason != "conflict" || env.Msg != "正在停止取回，请稍后再试" {
		t.Fatalf("unexpected 409 envelope: %+v", env)
	}
}
