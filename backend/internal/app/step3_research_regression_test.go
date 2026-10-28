package app

// #83 固定研究夹具的正式回归适配：扣费事实来自任务，恢复复用现有入口。
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestStep3BillingContract(t *testing.T) {
	for _, tc := range []struct {
		name, kind, usage, billing, recovery, want string
		usagePresent, billingPresent               bool
	}{
		{"video_failed", "canvas_video", "failed", "", "no_result", "allowed", true, false},
		{"video_pending", "canvas_video", "pending", "", "no_result", "blocked", true, false},
		{"image_empty", "canvas_image", "", "", "no_result", "blocked", false, true},
		{"image_absent", "canvas_image", "", "", "no_result", "confirm", false, false},
		{"refunded_unrecoverable", "canvas_image", "", "refunded", "unrecoverable", "allowed", false, true},
		{"settled_unrecoverable", "canvas_image", "", "settled", "unrecoverable", "confirm", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			task := model.Task{ID: "billing", UserID: "user", Type: tc.kind, Status: model.TaskStatusFailed, RecoveryOutcome: &tc.recovery}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			task.BillingEvidence = &model.TaskBillingEvidence{Source: "beefapi", RouteRun: task.RouteRun, UsageState: tc.usage, BillingState: tc.billing, UsageStatePresent: tc.usagePresent, BillingStatePresent: tc.billingPresent}
			if err := s.repo.UpdateTaskBillingEvidence(task, task.BillingEvidence); err != nil {
				t.Fatal(err)
			}
			reloaded, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			task = *reloaded
			facts := s.taskOutcomeFacts([]model.Task{task})[task.ID]
			got := localtask.ComputeOutcome(task, "", facts)
			if got.Phase != "failed" || got.Regenerate != tc.want {
				t.Fatalf("持久事实投影=%+v，期望 failed/%s", got, tc.want)
			}
		})
	}
}

func TestStep3OldBillingMustNotAuthorizeNewRun(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	noResult := "no_result"
	task := model.Task{ID: "reused-task", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, RouteRun: 1, RecoveryOutcome: &noResult}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	old := model.ApiCallLog{ID: "old-refund", UserID: task.UserID, TaskID: task.ID, Source: "beefapi", ChannelID: "old-channel", ProviderRequestID: "old-provider", BillingState: "refunded", BillingStatePresent: true}
	if err := db.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	// 同一个任务号进入第二轮，切到不提供扣费结论的渠道。
	if err := db.Model(&task).Updates(map[string]any{"route_run": 2, "channel_model_id": "third-party-model"}).Error; err != nil {
		t.Fatal(err)
	}
	current, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	got := localtask.ComputeOutcome(*current, "", s.taskOutcomeFacts([]model.Task{*current})[task.ID])
	if got.Regenerate != "confirm" {
		t.Fatalf("第二轮沿用了第一轮退款：%+v", got)
	}
}

func TestStep3FreeRetryReplayAfterDelivery(t *testing.T) {
	allowLoopbackProviderTest(t)
	s, db, _, _ := creationTestService(t)
	png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	var gets, creates atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(405)
			return
		}
		gets.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer server.Close()
	task := model.Task{ID: "free-replay", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, RouteRun: 3, InputJSON: `{"mode":"image"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	log := model.ApiCallLog{ID: "free-receipt", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: fmt.Sprintf(`{"data":[{"url":%q}]}`, server.URL+"/original.png")}
	if err := db.Create(&log).Error; err != nil {
		t.Fatal(err)
	}
	first, err := s.RetryTaskWithOperation(task.UserID, task.ID, "same-operation")
	if err != nil || first == nil {
		t.Fatalf("首次取回失败：%v", err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeliverSucceededTask(*stored); err != nil {
		t.Fatal(err)
	}
	_, replayErr := s.RetryTaskWithOperation(task.UserID, task.ID, "same-operation")
	var receipts, tasks int64
	db.Model(&model.AgentOpRecord{}).Where("op_id = ?", "same-operation").Count(&receipts)
	db.Model(&model.Task{}).Count(&tasks)
	stored, err = s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("GET=%d create=%d tasks=%d routeRun=%d receipts=%d replayError=%v", gets.Load(), creates.Load(), tasks, stored.RouteRun, receipts, replayErr)
	if creates.Load() != 0 || tasks != 1 || stored.RouteRun != 3 {
		t.Fatal("取回产生了额外生成")
	}
	if replayErr != nil {
		t.Fatalf("同编号重放应成功：%v", replayErr)
	}
}

func TestStep3RecoverResumesBothPauseStages(t *testing.T) {
	for _, stage := range []string{"delivery_paused", "delivery_timed_out"} {
		t.Run(stage, func(t *testing.T) {
			allowLoopbackProviderTest(t)
			s, db, _, _ := creationTestService(t)
			png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
			var gets, creates atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					creates.Add(1)
					w.WriteHeader(405)
					return
				}
				gets.Add(1)
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(png)
			}))
			defer server.Close()
			task := model.Task{ID: stage, UserID: "user", Type: "canvas_image", Status: model.TaskStatusSucceeded, Stage: stage, RouteRun: 4, ResultJSON: fmt.Sprintf(`{"mode":"image","images":[{"url":%q}]}`, server.URL+"/result.png")}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := s.RetryTask(task.UserID, task.ID); err != nil {
				t.Fatal(err)
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if deliveryPaused(stored.Stage) {
				t.Fatal("暂停未解除")
			}
			if err := s.DeliverSucceededTask(*stored); err != nil {
				t.Fatal(err)
			}
			got, err := s.Task(task.UserID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if gets.Load() != 1 || creates.Load() != 0 || got.RouteRun != 4 || got.Outcome == nil || got.Outcome.Phase != "ready" {
				t.Fatalf("取回没有完成：GET=%d create=%d outcome=%+v", gets.Load(), creates.Load(), got.Outcome)
			}
		})
	}
}

func TestStep3VideoBillingQueryPath(t *testing.T) {
	allowLoopbackProviderTest(t)
	var path string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		_, _ = w.Write([]byte(`{"id":"original","status":"processing"}`))
	}))
	defer provider.Close()
	input := canvasGenerationInput{Config: providerConfig{BaseURL: provider.URL + "/v1", APIKey: "fixture", InterfaceType: "beefapi"}}
	_, _, err := queryBeefAPIVideoResult(context.Background(), input, "original")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/video/generations/original" {
		t.Fatalf("扣费查询实际路径=%s", path)
	}
}

func TestStep3ScanMustNotStrandRecoverableTask(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	old := time.Now().Add(-25 * time.Hour)
	task := model.Task{ID: "old-video", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", CreatedAt: old, UpdatedAt: old}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	candidates, err := s.repo.FailedVideoTasksForRecovery("", 4)
	if err != nil {
		t.Fatal(err)
	}
	// 这里只验证“既不扫描又不结束”；未知期限仍入选也满足该合同。
	_ = s.recoverFailedProviderTasks(context.Background(), 4)
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	got := localtask.ComputeOutcome(*stored, "", s.taskOutcomeFacts([]model.Task{*stored})[task.ID])
	if len(candidates) == 0 && stored.RecoveryOutcome == nil && got.Phase == "retrievable" {
		t.Fatal("已被扫描排除，但仍投影为正在自动取回")
	}
}

func TestStep3DownloadFailureMustNotConcludeMissingResult(t *testing.T) {
	// 实际查询与下载，只有本地服务；短响应截断，不调用生成服务。
	allowLoopbackProviderTest(t)
	s, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, s, db)
	var queries, downloads atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/content") {
			downloads.Add(1)
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Length", "1000")
			_, _ = w.Write([]byte("short"))
			return
		}
		queries.Add(1)
		_, _ = w.Write([]byte(`{"id":"original","status":"completed"}`))
	}))
	defer provider.Close()
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: provider.URL, APIKey: "fixture", InterfaceType: "beefapi"}})
	task := model.Task{ID: "short-download", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(input), CreatedAt: time.Now()}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: provider.URL})
	queryErr := s.recoverFailedProviderTasks(ctx, 1)
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	outcome := ""
	if stored.RecoveryOutcome != nil {
		outcome = *stored.RecoveryOutcome
	}
	t.Logf("queries=%d downloads=%d outcome=%s error=%v", queries.Load(), downloads.Load(), outcome, queryErr)
	if queries.Load() == 0 || downloads.Load() == 0 {
		t.Fatal("未到达查询与下载")
	}
	if stored.RecoveryOutcome != nil {
		t.Fatalf("短暂下载失败变成永久结论：%s", *stored.RecoveryOutcome)
	}
}
