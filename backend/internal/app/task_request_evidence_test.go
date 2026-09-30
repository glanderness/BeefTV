package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Exercise the real HTTP reader, terminal capture, SQLite and list projection.
// A struct-only serialization test misses both successful headers and SELECT omissions.
func TestTaskRequestEvidenceHTTPToRestoredList(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, tc := range []struct {
		name                  string
		status                int
		body, source, outcome string
		completed             bool
	}{
		{"rejection", 400, `{"error":{"code":"invalid_size","message":"size must be 1024x1024"}}`, "upstream_http", "http_error", false},
		{"business_error", 200, `{"error":{"code":"invalid_size","message":"size must be 1024x1024"}}`, "upstream_response", "business_error", false},
		{"local_save", 200, `{"data":[{"url":"https://example.com/result.png"}]}`, "local_result", "response_received", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Request-Id", "req-real-header")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			task := model.Task{ID: "task", UserID: "user", Status: model.TaskStatusRunning}
			executor := taskRouteExecutor{port: taskRouteServiceAdapter{
				markDispatching: func(*model.RouteAttempt) error { return nil },
				process: func(ctx context.Context, _ model.Task) (map[string]interface{}, []map[string]interface{}, error) {
					req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/v1/images/edits", strings.NewReader(`{}`))
					var payload map[string]interface{}
					err := doJSON(req, &payload)
					return payload, nil, err
				},
				refreshState:     func(*model.Task) error { return nil },
				finishAttempt:    func(*model.RouteAttempt, *model.Task, error) {},
				nextAfterFailure: func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error) { return nil, nil },
			}}
			execution, err := executor.execute(context.Background(), &task, &model.RouteAttempt{})
			if err != nil {
				t.Fatal(err)
			}
			err = execution.err
			if tc.completed {
				err = errors.New("cannot save /Users/private-name/image.png")
			}
			if err == nil {
				t.Fatal("expected terminal error")
			}
			captureTaskFailureDiagnostics(&task, err, tc.source)
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, _ := db.DB()
			defer sqlDB.Close()
			if err = db.AutoMigrate(&model.Task{}); err != nil {
				t.Fatal(err)
			}
			if err = db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			repo := repository.New(db)
			ok, err := repo.UpdateTaskTerminalState(task.ID, "", model.TaskStatusRunning, model.TaskStatusFailed, "失败", "通用文案", time.Now(), task.FailureDiagnostics)
			if !ok || err != nil {
				t.Fatalf("terminal: %v %v", ok, err)
			}
			tasks, err := repo.Tasks("user", 10, "", false)
			if err != nil || len(tasks) != 1 {
				t.Fatalf("list %v %v", tasks, err)
			}
			d := taskSummaryForOutput(tasks[0]).FailureDiagnostics
			if d == nil || d.Source != tc.source || len(d.Requests) != 1 {
				t.Fatalf("diagnostics %+v", d)
			}
			r := d.Requests[0]
			if r.RequestID != "req-real-header" || r.HTTPStatus != tc.status || r.Outcome != tc.outcome || !r.Dispatched || r.ReceivedBytes != int64(len(tc.body)) {
				t.Fatalf("request %+v", r)
			}
			if tc.completed && (d.ExecutionResult != "completed" || strings.Contains(d.Summary, "private-name")) {
				t.Fatalf("local result %+v", d)
			}
			if !tc.completed && d.RequestID != "req-real-header" {
				t.Fatalf("lost header %+v", d)
			}
		})
	}
}

func TestTaskRequestEvidenceCancellationAndBound(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	ctx, recorder := withTaskRequestEvidence(context.Background())
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:1/v1/images/edits", nil)
	for i := 0; i < 10; i++ {
		_, _, _ = doBinary(req)
	}
	d := recorder.snapshot(false)
	if len(d.Requests) != 8 || d.OmittedRequests != 2 || d.Requests[0].Outcome != "cancelled" {
		t.Fatalf("trace %+v", d)
	}
	d.Requests[0].RequestID = "mutated"
	if recorder.snapshot(false).Requests[0].RequestID != "" {
		t.Fatal("snapshot aliases recorder")
	}
}

func TestTaskRequestEvidenceResumesOriginalSubmission(t *testing.T) {
	prior := &model.TaskFailureDiagnostics{ExecutionResult: "pending", Requests: []model.TaskRequestEvidence{{Operation: "submit", RequestID: "req-original-submit", Outcome: "response_received", HTTPStatus: 200}}}
	ctx, recorder := withTaskRequestEvidence(context.Background(), prior)
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://example.com/poll", nil)
	for i := 0; i < 12; i++ {
		recordTaskRequestEvidence(req, model.TaskRequestEvidence{HTTPStatus: 200, RequestID: "req-poll", Dispatched: true}, nil, nil)
	}
	d := recorder.snapshot(false)
	if len(d.Requests) != 8 || d.OmittedRequests != 5 || d.Requests[0].RequestID != "req-original-submit" || d.Requests[7].RequestID != "req-poll" {
		t.Fatalf("resumed trace %+v", d)
	}
	if len(prior.Requests) != 1 {
		t.Fatal("mutated persisted snapshot")
	}
}

func TestTaskRequestEvidenceLocalInputConstraint(t *testing.T) {
	ctx, recorder := withTaskRequestEvidence(context.Background())
	input := canvasGenerationInput{Prompt: "PRIVATE prompt", Config: providerConfig{Model: "gpt-image-2", Size: "2048x2048", Quality: "medium", Count: "1"}, ReferenceImages: []providerMedia{{Bytes: 1234, Width: 1024, Height: 1024}, {}, {}}, ImageCapability: &ImageCapabilityConfig{References: ImageReferenceConfig{MaxImages: 2, MaxImageBytes: 5000}}}
	recordTaskDiagnosticInput(ctx, input)
	err := validateImageTask(input.ImageCapability, input)
	if err == nil {
		t.Fatal("expected reference limit")
	}
	task := model.Task{FailureDiagnostics: recorder.snapshot(false)}
	captureTaskFailureDiagnostics(&task, err, "unknown")
	d := task.FailureDiagnostics
	if d.Source != "local_validation" || len(d.Requests) != 0 || d.Input.ImageCount != 3 || d.Input.MaxImages != 2 || d.Input.Size != "2048x2048" || d.Input.Count != "1" || d.Platform == "" {
		t.Fatalf("local diagnostic %+v input %+v", d, d.Input)
	}
}

func TestTaskRequestEvidenceResponseLimit(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-ID", "req-too-large")
		w.Header().Set("Content-Length", strconv.FormatInt(maxProviderResponseBytes+1, 10))
		w.WriteHeader(200)
	}))
	defer server.Close()
	ctx, recorder := withTaskRequestEvidence(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	_, _, err := doBinary(req)
	if err == nil {
		t.Fatal("expected response limit")
	}
	task := model.Task{FailureDiagnostics: recorder.snapshot(false)}
	captureTaskFailureDiagnostics(&task, err, "unknown")
	d := task.FailureDiagnostics
	if d.Source != "local_response" || d.RequestID != "req-too-large" || len(d.Requests) != 1 {
		t.Fatalf("diagnostic %+v", d)
	}
	r := d.Requests[0]
	if r.Outcome != "response_limit" || r.DeclaredResponseBytes != maxProviderResponseBytes+1 || r.ResponseLimitBytes != maxProviderResponseBytes {
		t.Fatalf("request %+v", r)
	}
}
