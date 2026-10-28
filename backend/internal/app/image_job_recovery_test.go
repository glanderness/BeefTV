package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestImageJobResultQueriesCurrentRouteWithoutCreating(t *testing.T) {
	allowLoopbackProviderTest(t)
	var jobQueries, downloads, posts atomic.Int32
	pngPayload, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if r.URL.Path == "/image.png" {
				downloads.Add(1)
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(pngPayload)
				return
			}
			jobQueries.Add(1)
			if r.URL.Path != "/v1/images/jobs/job-current" {
				t.Fatalf("unexpected query path %s", r.URL.Path)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":        "succeeded",
				"billing_state": "refunded",
				"data":          []map[string]any{{"url": server.URL + "/image.png"}},
			})
		default:
			posts.Add(1)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", server.URL)

	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	now := time.Now()
	task := model.Task{
		ID: "failed-image-job", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, RouteRun: 4,
		InputJSON: `{"mode":"image","config":{"baseUrl":"` + server.URL + `","apiKey":"provider-key"}}`,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "old-job", UserID: task.UserID, TaskID: task.ID, RouteRun: 3, Source: "beefapi", Capability: "image", RequestKind: "create", Method: http.MethodPost, ImageJobID: "job-old", CreatedAt: now.Add(-time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "current-job", UserID: task.UserID, TaskID: task.ID, RouteRun: task.RouteRun, Source: "beefapi", Capability: "image", RequestKind: "create", Method: http.MethodPost, ImageJobID: "job-current", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}

	result, handled, err := svc.imageJobResult(context.Background(), task)
	if err != nil || !handled || len(result) == 0 || jobQueries.Load() != 1 || downloads.Load() != 1 || posts.Load() != 0 {
		t.Fatalf("result bytes=%d handled=%v err=%v queries=%d downloads=%d POST=%d", len(result), handled, err, jobQueries.Load(), downloads.Load(), posts.Load())
	}
	var payload map[string]any
	if err := json.Unmarshal(result, &payload); err != nil || payload["mode"] != "image" {
		t.Fatalf("recovery payload=%s err=%v", result, err)
	}
	var saved model.Task
	if err := db.First(&saved, "id = ?", task.ID).Error; err != nil || saved.BillingEvidence == nil || saved.BillingEvidence.RouteRun != task.RouteRun || saved.BillingEvidence.BillingState != "refunded" {
		t.Fatalf("billing evidence=%+v err=%v", saved.BillingEvidence, err)
	}
}
