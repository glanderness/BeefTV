package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func recoveryTestAdapter(t *testing.T) protocol.Adapter {
	t.Helper()
	body, err := os.ReadFile("../../../plugin-packages/newapi-video-generations-v1/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := protocol.LoadManifest(body)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func TestVideoRecoveryLostReceiptNeverResubmits(t *testing.T) {
	allowLoopbackProviderTest(t)
	creates, polls := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			creates++
			_, _ = io.Copy(io.Discard, r.Body)
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		polls++
	}))
	defer server.Close()
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, Model: "seedance-2.0-mini", InterfaceType: "newapi-channel-2"}}, recoveryTestAdapter(t), fastVideoPollPolicy())
	var unknown providerSubmissionUnknownError
	if creates != 1 || polls != 0 || result != nil || !errors.As(err, &unknown) {
		t.Fatalf("creates=%d polls=%d result=%v err=%v", creates, polls, result, err)
	}
	if !persistedFailureBlocksRetry(persistableTaskFailureMessage(err), "submission_unknown") {
		t.Fatal("lost receipt permits a paid retry")
	}
}

func TestVideoRecoverySubmissionClassification(t *testing.T) {
	for _, err := range []error{providerHTTPError{StatusCode: 429}, providerHTTPError{StatusCode: 404}, providerCircuitOpenError{}, context.Canceled} {
		var unknown providerSubmissionUnknownError
		if errors.As(uncertainVideoSubmission(context.Background(), err), &unknown) {
			t.Fatalf("known rejection wrapped: %v", err)
		}
	}
	for _, err := range []error{io.EOF, io.ErrUnexpectedEOF, context.DeadlineExceeded, providerHTTPError{StatusCode: 524}} {
		var unknown providerSubmissionUnknownError
		if !errors.As(uncertainVideoSubmission(context.Background(), err), &unknown) {
			t.Fatalf("lost receipt not protected: %v", err)
		}
	}
}

func TestVideoRecoverySocketResetNeverResubmits(t *testing.T) {
	allowLoopbackProviderTest(t)
	creates, polls, downloads := 0, 0, 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			creates++
			_, _ = io.WriteString(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"IN_PROGRESS"}}`)
			return
		}
		if r.URL.Path == "/result.mp4" {
			downloads++
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("test-video"))
			return
		}
		polls++
		if polls == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			// Abort TCP with RST: on Windows the client receives WSAECONNRESET.
			_ = conn.(*net.TCPConn).SetLinger(0)
			_ = conn.Close()
			return
		}
		if r.URL.Path != "/v1/video/generations/original-paid-task" {
			t.Errorf("unexpected task query: %s", r.URL.Path)
		}
		_, _ = fmt.Fprintf(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"SUCCESS","result_url":%q}}`, server.URL+"/result.mp4")
	}))
	defer server.Close()
	input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, Model: "seedance-2.0-mini", InterfaceType: "newapi-channel-2"}}
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), input, recoveryTestAdapter(t), fastVideoPollPolicy())
	if err != nil || result == nil || creates != 1 || polls != 2 || downloads != 1 {
		t.Fatalf("creates=%d polls=%d downloads=%d result=%v err=%v", creates, polls, downloads, result, err)
	}
}

func TestVideoRecoveryDownloadDisconnectKeepsOriginalTask(t *testing.T) {
	for _, alwaysBroken := range []bool{false, true} {
		t.Run(fmt.Sprint(alwaysBroken), func(t *testing.T) {
			allowLoopbackProviderTest(t)
			creates, polls, downloads := 0, 0, 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					creates++
					_, _ = io.WriteString(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"IN_PROGRESS"}}`)
					return
				}
				if r.URL.Path == "/result.mp4" {
					downloads++
					if alwaysBroken || downloads == 1 {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("test-video"))
					return
				}
				polls++
				_, _ = fmt.Fprintf(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"SUCCESS","result_url":%q}}`, server.URL+"/result.mp4")
			}))
			defer server.Close()
			input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, Model: "seedance-2.0-mini", InterfaceType: "newapi-channel-2"}}
			result, err := runProtocolAdapterTaskWithPolicy(context.Background(), input, recoveryTestAdapter(t), fastVideoPollPolicy())
			if creates != 1 || polls != 1 || downloads < 2 {
				t.Fatalf("creates=%d polls=%d downloads=%d", creates, polls, downloads)
			}
			if !alwaysBroken {
				if err != nil || result == nil {
					t.Fatalf("failed to recover: %v", err)
				}
				return
			}
			started := time.Now()
			task := model.Task{ID: "local", Type: "canvas_video", ProviderRequestID: "original-paid-task", StartedAt: &started}
			body, _ := json.Marshal(input)
			svc := &Service{}
			if err == nil || !svc.shouldDeferVideoProviderTask(task, string(body), err) {
				t.Fatalf("download result abandoned: %v", err)
			}
			started = started.Add(-25 * time.Hour)
			if svc.shouldDeferVideoProviderTask(task, string(body), err) {
				t.Fatal("automatic recovery is unbounded")
			}
			if svc.shouldDeferVideoProviderTask(task, string(body), context.Canceled) {
				t.Fatal("cancelled task resurrected")
			}
		})
	}
}

func TestVideoRecoveryBeefAPIQueryUsesOnlyGet(t *testing.T) {
	allowLoopbackProviderTest(t)
	queries, downloads := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unsafe method %s", r.Method)
			w.WriteHeader(400)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing query authentication")
		}
		if r.URL.Path == "/v1/videos/original/content" {
			downloads++
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("test-video"))
			return
		}
		queries++
		_, _ = io.WriteString(w, `{"data":{"id":"original","status":"completed"}}`)
	}))
	defer server.Close()
	result, _, err := queryBeefAPIVideoResult(context.Background(), canvasGenerationInput{Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key"}}, "original")
	if err != nil || result == nil || queries != 1 || downloads != 1 {
		t.Fatalf("result=%v err=%v queries=%d downloads=%d", result, err, queries, downloads)
	}
}

func TestVideoRecoveryTaskLogsExplainFailureWithoutRawPayload(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	log := model.TaskLog{ID: "log-recovery", UserID: "owner", TaskID: "task-recovery", Level: "error", Message: "任务处理失败", Payload: "视频结果下载失败：EOF https://private.example/result?token=secret-value"}
	if err := db.Create(&log).Error; err != nil {
		t.Fatal(err)
	}
	logs, err := svc.TaskLogs("owner", "task-recovery")
	if err != nil || len(logs) != 1 {
		t.Fatalf("logs=%v err=%v", logs, err)
	}
	if !strings.Contains(logs[0].Summary, "任务处理失败") || logs[0].Message != "" || logs[0].Payload != "" || strings.Contains(logs[0].Summary, "secret-value") {
		t.Fatalf("unsafe or missing summary: %#v", logs[0])
	}
	other, err := svc.TaskLogs("other-user", "task-recovery")
	if err != nil || len(other) != 0 {
		t.Fatal("logs crossed ownership")
	}
}
