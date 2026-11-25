package taskdelivery

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskruntime"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type cf524NopReplay struct{}

func (cf524NopReplay) FinalizeTaskTextReplay(string, model.TaskStatus) error { return nil }

type cf524NopLogger struct{}

func (cf524NopLogger) Log(string, string, string, string, string) error { return nil }

type cf524NopOutputs struct{}

func (cf524NopOutputs) DeliverSucceededTask(model.Task) error       { return nil }
func (cf524NopOutputs) RegisterTaskOutputFromTask(model.Task) error { return nil }

type cf524TestSession struct {
	ctx  context.Context
	task *model.Task
}

func (s cf524TestSession) Context() context.Context { return s.ctx }
func (s cf524TestSession) Task() *model.Task        { return s.task }
func (s cf524TestSession) Lost() bool               { return false }
func (s cf524TestSession) LostErr() error           { return nil }

func newCF524Fixture(t *testing.T) (*gorm.DB, *repository.Repository, *taskruntime.Terminal, *Deliverer) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	terminal := taskruntime.NewTerminal(taskruntime.TerminalDependencies{
		Repository:        repo,
		Replay:            cf524NopReplay{},
		Logger:            cf524NopLogger{},
		Outputs:           cf524NopOutputs{},
		UserFacingMessage: localtask.TaskFailureMessage,
		FailureErrorCode:  generation.TaskFailureErrorCode,
		CaptureFailure:    generation.CaptureTaskFailureDiagnostics,
	})
	deliverer := New(NewRepoStore(repo, localtask.PublicTaskInputJSON), nil)
	return db, repo, terminal, deliverer
}

func outcomeFactsForTask(repo *repository.Repository) func([]model.Task) map[string]localtask.OutcomeFacts {
	return func(tasks []model.Task) map[string]localtask.OutcomeFacts {
		ids := make([]string, 0, len(tasks))
		for _, item := range tasks {
			ids = append(ids, item.ID)
		}
		evidence, err := repo.ImageRecoveryEvidence(ids)
		if err != nil {
			out := make(map[string]localtask.OutcomeFacts, len(tasks))
			for _, item := range tasks {
				out[item.ID] = localtask.OutcomeFacts{Unreadable: true}
			}
			return out
		}
		out := make(map[string]localtask.OutcomeFacts, len(tasks))
		for _, item := range tasks {
			ev := evidence[item.ID]
			facts := localtask.OutcomeFacts{
				RequestNotSent: item.Stage == taskruntime.StageRequestNotSent,
			}
			if ev.Attempt != nil && ev.Attempt.RouteRun == item.RouteRun {
				facts.DispatchState = ev.Attempt.DispatchState
			}
			if ev.Submission != nil {
				facts.ImageResponseAccepted = ev.Submission.ResponseAccepted
			}
			out[item.ID] = facts
		}
		return out
	}
}

func TestThirdPartyImageEditsCloudflare524PreservesCauseAndAllowsConfirmRegenerate(t *testing.T) {
	db, repo, terminal, deliverer := newCF524Fixture(t)
	now := time.Now()
	expires := now.Add(time.Hour)
	taskRow := model.Task{
		ID:             "task-cf524-thirdparty",
		UserID:         "user-cf524",
		ProjectID:      "canvas-cf524",
		Type:           "canvas_image",
		Status:         model.TaskStatusRunning,
		LeaseOwner:     "worker-cf524",
		LeaseExpiresAt: &expires,
		RouteRun:       1,
		Prompt:         "把背景换成晚霞",
		InputJSON:      `{"mode":"image","config":{"baseUrl":"https://relay.thirdparty.example/v1","model":"gpt-image-1"}}`,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := db.Create(&taskRow).Error; err != nil {
		t.Fatal(err)
	}

	attempt := &model.RouteAttempt{
		ID:            "attempt-cf524-thirdparty",
		TaskID:        taskRow.ID,
		RouteRun:      1,
		AttemptNumber: 1,
		ChannelID:     "custom-relay",
		Status:        "pending",
		DispatchState: "not_sent",
		StartedAt:     now,
	}
	if err := db.Create(attempt).Error; err != nil {
		t.Fatal(err)
	}

	cf524Err := generation.HTTPError{
		StatusCode: 524,
		Status:     "524 A Timeout Occurred",
		Body:       `<!DOCTYPE html><html><head><title>relay.thirdparty.example | 524: A timeout occurred</title></head><body>Cloudflare 524 A timeout occurred</body></html>`,
	}

	execOutcome := localtask.ExecuteClaimedTask(localtask.WorkerExecuteDeps{
		Repo:     repo,
		Terminal: terminal,
		Log:      func(string, string, string, string, string) error { return nil },
		BeginRouteAttempt: func(*model.Task) (*model.RouteAttempt, error) {
			return attempt, nil
		},
		ExecuteRoute: func(ctx context.Context, current *model.Task, currentAttempt *model.RouteAttempt) (localtask.RouteExecutionResult, error) {
			return localtask.ExecuteRouteAttemptLoop(ctx, localtask.RouteExecuteDeps{
				MarkDispatching: func(a *model.RouteAttempt) error {
					a.Status = "dispatching"
					return repo.SaveRouteAttempt(a)
				},
				Process: func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error) {
					return nil, nil, cf524Err
				},
				RefreshState: func(*model.Task) error { return nil },
				FinishAttempt: func(a *model.RouteAttempt, _ *model.Task, taskErr error) {
					a.Status = "failed"
					a.DispatchState = "submission_unknown"
					a.FailureCode = "upstream_524"
					_ = repo.SaveRouteAttempt(a)
				},
				NextAfterFailure: func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error) { return nil, nil },
				WriteLog:         func(string, string, string, string, string) error { return nil },
				IsRecoveryErr:    func(error) bool { return false },
				IsVODParamErr:    func(error) bool { return false },
				IsImageThrottle:  func(error) bool { return false },
			}, current, currentAttempt)
		},
		DecryptTaskInput:      func(raw string) (string, error) { return raw, nil },
		ShouldDeferImage:      func(model.Task, error, bool) bool { return false },
		DeferImage:            func(model.Task) error { return nil },
		ResolveProviderConfig: func(cfg generation.Config) (generation.Config, error) { return cfg, nil },
		ImageTaskEnded:        func(error) bool { return false },
		SaveTaskCompletion:    func(*model.Task, []byte, []byte, bool) error { return nil },
		PersistGeneratedMedia: func(_ model.Task, r map[string]interface{}) (map[string]interface{}, error) { return r, nil },
		FinalizeTurnaround:    func(model.Task, map[string]interface{}) (bool, error) { return false, nil },
	}, cf524TestSession{ctx: context.Background(), task: &taskRow})

	if !execOutcome.Applied {
		t.Fatalf("expected terminal write to apply: %+v", execOutcome)
	}

	stored, err := repo.Task(taskRow.ID)
	if err != nil {
		t.Fatal(err)
	}

	view := localtask.TaskForOutput(*stored)
	AttachTaskDelivery(deliverer, view, nil, outcomeFactsForTask(repo), generation.PersistedFailureBlocksRetry(stored.Error, stored.Stage, stored.ErrorCode), nil)

	if view.ErrorCode != string(generation.CategoryTimeout) {
		t.Fatalf("ErrorCode = %q, want %q (error=%q stage=%q)", view.ErrorCode, generation.CategoryTimeout, view.Error, view.Stage)
	}
	if !strings.Contains(view.Error, "524") || !strings.Contains(view.Error, "网关") {
		t.Fatalf("Error must clearly classify upstream HTTP 524 gateway timeout, got %q", view.Error)
	}
	if !strings.Contains(view.Error, "keep-alive") && !strings.Contains(view.Error, "保活") {
		t.Fatalf("Error must include keep-alive/timeout guidance, got %q", view.Error)
	}
	if !strings.Contains(view.Error, "可能仍在服务端执行") || !strings.Contains(view.Error, "不要立即重新提交") {
		t.Fatalf("Error must keep uncertain execution warning, got %q", view.Error)
	}
	if view.FailureDiagnostics == nil || view.FailureDiagnostics.HTTPStatus != 524 || view.FailureDiagnostics.Source != "upstream_http" {
		t.Fatalf("FailureDiagnostics lost HTTP 524 metadata: %+v", view.FailureDiagnostics)
	}
	wantOutcome := localtask.Outcome{Phase: "failed", Regenerate: "confirm", Reason: "result_unrecoverable"}
	if view.Outcome == nil || *view.Outcome != wantOutcome {
		t.Fatalf("third-party HTTP 524 Outcome = %+v, want %+v", view.Outcome, wantOutcome)
	}

	// Summary view must agree with detail view.
	summaries := localtask.SummariesForOutput([]model.Task{*stored})
	AttachTaskSummaryDeliveries(deliverer, []model.Task{*stored}, summaries, outcomeFactsForTask(repo), generation.PersistedFailureBlocksRetry, nil, nil)
	if summaries[0].ErrorCode != string(generation.CategoryTimeout) || summaries[0].Outcome == nil || *summaries[0].Outcome != wantOutcome {
		t.Fatalf("summary drifted from detail: errorCode=%q outcome=%+v error=%q", summaries[0].ErrorCode, summaries[0].Outcome, summaries[0].Error)
	}
}

func TestRecoverableImageSubmissionCloudflare524KeepsRetrievableOutcome(t *testing.T) {
	db, repo, terminal, deliverer := newCF524Fixture(t)
	now := time.Now()
	expires := now.Add(time.Hour)
	taskRow := model.Task{
		ID:             "task-cf524-recoverable",
		UserID:         "user-cf524",
		ProjectID:      "canvas-cf524",
		Type:           "canvas_image",
		Status:         model.TaskStatusRunning,
		LeaseOwner:     "worker-cf524",
		LeaseExpiresAt: &expires,
		RouteRun:       1,
		Prompt:         "恢复测试",
		InputJSON:      `{"mode":"image","config":{"baseUrl":"https://beeftv.app/v1","model":"gpt-image-1","credentialRef":"beeftv"}}`,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	attempt := &model.RouteAttempt{
		ID:            "attempt-cf524-recoverable",
		TaskID:        taskRow.ID,
		RouteRun:      1,
		AttemptNumber: 1,
		ChannelID:     "beeftv",
		Status:        "pending",
		DispatchState: "not_sent",
		StartedAt:     now,
	}
	submission := &model.ImageSubmission{
		AttemptID:     attempt.ID,
		TaskID:        taskRow.ID,
		UserID:        taskRow.UserID,
		RequestCipher: "encrypted-payload",
		SendCount:     1,
		CreatedAt:     now,
	}
	for _, row := range []any{&taskRow, attempt, submission} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}

	cf524Err := generation.HTTPError{StatusCode: 524, Status: "524 A Timeout Occurred", Body: "<html>524</html>"}
	localtask.ExecuteClaimedTask(localtask.WorkerExecuteDeps{
		Repo:     repo,
		Terminal: terminal,
		Log:      func(string, string, string, string, string) error { return nil },
		BeginRouteAttempt: func(*model.Task) (*model.RouteAttempt, error) {
			return attempt, nil
		},
		ExecuteRoute: func(ctx context.Context, current *model.Task, currentAttempt *model.RouteAttempt) (localtask.RouteExecutionResult, error) {
			return localtask.ExecuteRouteAttemptLoop(ctx, localtask.RouteExecuteDeps{
				MarkDispatching: func(a *model.RouteAttempt) error {
					a.Status = "dispatching"
					return repo.SaveRouteAttempt(a)
				},
				Process: func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error) {
					return nil, nil, cf524Err
				},
				RefreshState: func(*model.Task) error { return nil },
				FinishAttempt: func(a *model.RouteAttempt, _ *model.Task, _ error) {
					a.Status = "failed"
					a.DispatchState = "submission_unknown"
					a.FailureCode = "upstream_524"
					_ = repo.SaveRouteAttempt(a)
				},
				NextAfterFailure: func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error) { return nil, nil },
				WriteLog:         func(string, string, string, string, string) error { return nil },
				IsRecoveryErr:    func(error) bool { return false },
				IsVODParamErr:    func(error) bool { return false },
				IsImageThrottle:  func(error) bool { return false },
			}, current, currentAttempt)
		},
		DecryptTaskInput:      func(raw string) (string, error) { return raw, nil },
		ShouldDeferImage:      func(model.Task, error, bool) bool { return false },
		DeferImage:            func(model.Task) error { return nil },
		ResolveProviderConfig: func(cfg generation.Config) (generation.Config, error) { return cfg, nil },
		ImageTaskEnded:        func(error) bool { return false },
		SaveTaskCompletion:    func(*model.Task, []byte, []byte, bool) error { return nil },
		PersistGeneratedMedia: func(_ model.Task, r map[string]interface{}) (map[string]interface{}, error) { return r, nil },
		FinalizeTurnaround:    func(model.Task, map[string]interface{}) (bool, error) { return false, nil },
	}, cf524TestSession{ctx: context.Background(), task: &taskRow})

	stored, err := repo.Task(taskRow.ID)
	if err != nil {
		t.Fatal(err)
	}
	view := localtask.TaskForOutput(*stored)
	AttachTaskDelivery(deliverer, view, nil, outcomeFactsForTask(repo), generation.PersistedFailureBlocksRetry(stored.Error, stored.Stage, stored.ErrorCode), nil)
	wantOutcome := localtask.Outcome{Phase: "retrievable", Regenerate: "blocked", Reason: "image_recovery_pending"}
	if view.Outcome == nil || *view.Outcome != wantOutcome {
		t.Fatalf("recoverable HTTP 524 Outcome = %+v, want %+v", view.Outcome, wantOutcome)
	}
	if view.ErrorCode != string(generation.CategoryTimeout) || !strings.Contains(view.Error, "524") {
		t.Fatalf("recoverable HTTP 524 hid timeout cause: code=%q err=%q", view.ErrorCode, view.Error)
	}
}

func TestCloudflare524FailClosedWhenEvidenceMissingOrManaged(t *testing.T) {
	wantRetrievable := localtask.Outcome{Phase: "retrievable", Regenerate: "blocked", Reason: "image_recovery_pending"}
	cf524Err := generation.HTTPError{StatusCode: 524, Status: "524 A Timeout Occurred", Body: "<html>524</html>"}

	cases := []struct {
		name           string
		inputJSON      string
		attemptChannel string
		persistAttempt bool
		decryptErr     error
		processErr     error
	}{
		{
			name:           "decrypt_input_error",
			inputJSON:      "cipher:unreadable",
			attemptChannel: "custom-relay",
			persistAttempt: true,
			decryptErr:     errors.New("decrypt failed"),
			processErr:     cf524Err,
		},
		{
			name:           "missing_attempt_record",
			inputJSON:      `{"mode":"image","config":{"baseUrl":"https://relay.thirdparty.example/v1","model":"gpt-image-1"}}`,
			attemptChannel: "custom-relay",
			persistAttempt: false,
			processErr:     generation.SubmissionUnknownError{Cause: cf524Err},
		},
		{
			name:           "empty_attempt_channel",
			inputJSON:      `{"mode":"image","config":{"baseUrl":"https://relay.thirdparty.example/v1","model":"gpt-image-1"}}`,
			attemptChannel: "",
			persistAttempt: true,
			processErr:     cf524Err,
		},
		{
			name:           "managed_without_submission",
			inputJSON:      `{"mode":"image","config":{"baseUrl":"https://beeftv.app/v1","model":"gpt-image-1","credentialRef":"beeftv","channelId":"beeftv"}}`,
			attemptChannel: "beeftv",
			persistAttempt: true,
			processErr:     cf524Err,
		},
		{
			name:           "base_url_only_managed",
			inputJSON:      `{"mode":"image","config":{"baseUrl":"https://api.beeftv.app/v1","model":"gpt-image-1"}}`,
			attemptChannel: "custom-relay",
			persistAttempt: true,
			processErr:     cf524Err,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, repo, terminal, deliverer := newCF524Fixture(t)
			now := time.Now()
			expires := now.Add(time.Hour)
			taskRow := model.Task{
				ID:             "task-cf524-" + tc.name,
				UserID:         "user-cf524",
				ProjectID:      "canvas-cf524",
				Type:           "canvas_image",
				Status:         model.TaskStatusRunning,
				LeaseOwner:     "worker-cf524",
				LeaseExpiresAt: &expires,
				RouteRun:       1,
				Prompt:         "fail-closed 验证",
				InputJSON:      tc.inputJSON,
				CreatedAt:      now,
				UpdatedAt:      now,
			}
			if err := db.Create(&taskRow).Error; err != nil {
				t.Fatal(err)
			}
			attempt := &model.RouteAttempt{
				ID:            "attempt-cf524-" + tc.name,
				TaskID:        taskRow.ID,
				RouteRun:      1,
				AttemptNumber: 1,
				ChannelID:     tc.attemptChannel,
				Status:        "pending",
				DispatchState: "not_sent",
				StartedAt:     now,
			}
			if tc.persistAttempt {
				if err := db.Create(attempt).Error; err != nil {
					t.Fatal(err)
				}
			}

			localtask.ExecuteClaimedTask(localtask.WorkerExecuteDeps{
				Repo:     repo,
				Terminal: terminal,
				Log:      func(string, string, string, string, string) error { return nil },
				BeginRouteAttempt: func(*model.Task) (*model.RouteAttempt, error) {
					return attempt, nil
				},
				ExecuteRoute: func(ctx context.Context, current *model.Task, currentAttempt *model.RouteAttempt) (localtask.RouteExecutionResult, error) {
					return localtask.ExecuteRouteAttemptLoop(ctx, localtask.RouteExecuteDeps{
						MarkDispatching: func(a *model.RouteAttempt) error {
							a.Status = "dispatching"
							if tc.persistAttempt {
								return repo.SaveRouteAttempt(a)
							}
							return nil
						},
						Process: func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error) {
							return nil, nil, tc.processErr
						},
						RefreshState: func(*model.Task) error { return nil },
						FinishAttempt: func(a *model.RouteAttempt, _ *model.Task, _ error) {
							a.Status = "failed"
							a.DispatchState = "submission_unknown"
							a.FailureCode = "upstream_524"
							if tc.persistAttempt {
								_ = repo.SaveRouteAttempt(a)
							}
						},
						NextAfterFailure: func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error) { return nil, nil },
						WriteLog:         func(string, string, string, string, string) error { return nil },
						IsRecoveryErr:    func(error) bool { return false },
						IsVODParamErr:    func(error) bool { return false },
						IsImageThrottle:  func(error) bool { return false },
					}, current, currentAttempt)
				},
				DecryptTaskInput: func(raw string) (string, error) {
					if tc.decryptErr != nil {
						return "", tc.decryptErr
					}
					return raw, nil
				},
				ShouldDeferImage:      func(model.Task, error, bool) bool { return false },
				DeferImage:            func(model.Task) error { return nil },
				ResolveProviderConfig: func(cfg generation.Config) (generation.Config, error) { return cfg, nil },
				ImageTaskEnded:        func(error) bool { return false },
				SaveTaskCompletion:    func(*model.Task, []byte, []byte, bool) error { return nil },
				PersistGeneratedMedia: func(_ model.Task, r map[string]interface{}) (map[string]interface{}, error) { return r, nil },
				FinalizeTurnaround:    func(model.Task, map[string]interface{}) (bool, error) { return false, nil },
			}, cf524TestSession{ctx: context.Background(), task: &taskRow})

			stored, err := repo.Task(taskRow.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.RecoveryOutcome != nil {
				t.Fatalf("case %s bypassed fail-closed recovery: RecoveryOutcome=%q", tc.name, *stored.RecoveryOutcome)
			}
			view := localtask.TaskForOutput(*stored)
			AttachTaskDelivery(deliverer, view, nil, outcomeFactsForTask(repo), generation.PersistedFailureBlocksRetry(stored.Error, stored.Stage, stored.ErrorCode), nil)
			if view.Outcome == nil || *view.Outcome != wantRetrievable {
				t.Fatalf("case %s Outcome = %+v, want %+v", tc.name, view.Outcome, wantRetrievable)
			}
		})
	}
}

func TestCloudflare524ReceiptStatusCodeClassification(t *testing.T) {
	cf524Err := generation.HTTPError{StatusCode: 524, Status: "524 A Timeout Occurred", Body: "<html>524</html>"}
	wantUnrecoverable := localtask.Outcome{Phase: "failed", Regenerate: "confirm", Reason: "result_unrecoverable"}
	wantRetrievable := localtask.Outcome{Phase: "retrievable", Regenerate: "blocked", Reason: "image_recovery_pending"}

	cases := []struct {
		name               string
		receiptStatusCode  int
		expectUnrecoverble bool
	}{
		{name: "status_0_pending_receipt", receiptStatusCode: 0, expectUnrecoverble: true},
		{name: "status_100_informational", receiptStatusCode: 100, expectUnrecoverble: true},
		{name: "status_200_accepted", receiptStatusCode: 200, expectUnrecoverble: false},
		{name: "status_302_redirect", receiptStatusCode: 302, expectUnrecoverble: true},
		{name: "status_429_client_error", receiptStatusCode: 429, expectUnrecoverble: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, repo, terminal, deliverer := newCF524Fixture(t)
			now := time.Now()
			expires := now.Add(time.Hour)
			taskRow := model.Task{
				ID:             "task-cf524-receipt-" + tc.name,
				UserID:         "user-cf524",
				ProjectID:      "canvas-cf524",
				Type:           "canvas_image",
				Status:         model.TaskStatusRunning,
				LeaseOwner:     "worker-cf524",
				LeaseExpiresAt: &expires,
				RouteRun:       1,
				Prompt:         "回执状态码验证",
				InputJSON:      `{"mode":"image","config":{"baseUrl":"https://relay.thirdparty.example/v1","model":"gpt-image-1"}}`,
				CreatedAt:      now,
				UpdatedAt:      now,
			}
			attempt := &model.RouteAttempt{
				ID:            "attempt-cf524-receipt-" + tc.name,
				TaskID:        taskRow.ID,
				RouteRun:      1,
				AttemptNumber: 1,
				ChannelID:     "custom-relay",
				Status:        "pending",
				DispatchState: "not_sent",
				StartedAt:     now,
			}
			receipt := &model.ApiCallLog{
				ID:          "receipt-" + tc.name,
				UserID:      taskRow.UserID,
				TaskID:      taskRow.ID,
				Capability:  "image",
				RequestKind: "create",
				Method:      "POST",
				Path:        "/v1/images/edits",
				StatusCode:  tc.receiptStatusCode,
				Status:      model.ApiCallStatusFailed,
				StartedAt:   now,
				CreatedAt:   now,
			}
			if tc.receiptStatusCode >= 200 && tc.receiptStatusCode < 300 {
				receipt.Status = model.ApiCallStatusSucceeded
			}
			for _, row := range []any{&taskRow, attempt, receipt} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}

			localtask.ExecuteClaimedTask(localtask.WorkerExecuteDeps{
				Repo:     repo,
				Terminal: terminal,
				Log:      func(string, string, string, string, string) error { return nil },
				BeginRouteAttempt: func(*model.Task) (*model.RouteAttempt, error) {
					return attempt, nil
				},
				ExecuteRoute: func(ctx context.Context, current *model.Task, currentAttempt *model.RouteAttempt) (localtask.RouteExecutionResult, error) {
					return localtask.ExecuteRouteAttemptLoop(ctx, localtask.RouteExecuteDeps{
						MarkDispatching: func(a *model.RouteAttempt) error {
							a.Status = "dispatching"
							return repo.SaveRouteAttempt(a)
						},
						Process: func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error) {
							return nil, nil, cf524Err
						},
						RefreshState: func(*model.Task) error { return nil },
						FinishAttempt: func(a *model.RouteAttempt, _ *model.Task, _ error) {
							a.Status = "failed"
							a.DispatchState = "submission_unknown"
							a.FailureCode = "upstream_524"
							_ = repo.SaveRouteAttempt(a)
						},
						NextAfterFailure: func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error) { return nil, nil },
						WriteLog:         func(string, string, string, string, string) error { return nil },
						IsRecoveryErr:    func(error) bool { return false },
						IsVODParamErr:    func(error) bool { return false },
						IsImageThrottle:  func(error) bool { return false },
					}, current, currentAttempt)
				},
				DecryptTaskInput:      func(raw string) (string, error) { return raw, nil },
				ShouldDeferImage:      func(model.Task, error, bool) bool { return false },
				DeferImage:            func(model.Task) error { return nil },
				ResolveProviderConfig: func(cfg generation.Config) (generation.Config, error) { return cfg, nil },
				ImageTaskEnded:        func(error) bool { return false },
				SaveTaskCompletion:    func(*model.Task, []byte, []byte, bool) error { return nil },
				PersistGeneratedMedia: func(_ model.Task, r map[string]interface{}) (map[string]interface{}, error) { return r, nil },
				FinalizeTurnaround:    func(model.Task, map[string]interface{}) (bool, error) { return false, nil },
			}, cf524TestSession{ctx: context.Background(), task: &taskRow})

			stored, err := repo.Task(taskRow.ID)
			if err != nil {
				t.Fatal(err)
			}
			view := localtask.TaskForOutput(*stored)
			AttachTaskDelivery(deliverer, view, nil, outcomeFactsForTask(repo), generation.PersistedFailureBlocksRetry(stored.Error, stored.Stage, stored.ErrorCode), nil)
			if tc.expectUnrecoverble {
				if stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != localtask.RecoveryUnrecoverable {
					t.Fatalf("case %s RecoveryOutcome = %v, want %q", tc.name, stored.RecoveryOutcome, localtask.RecoveryUnrecoverable)
				}
				if view.Outcome == nil || *view.Outcome != wantUnrecoverable {
					t.Fatalf("case %s Outcome = %+v, want %+v", tc.name, view.Outcome, wantUnrecoverable)
				}
			} else {
				if stored.RecoveryOutcome != nil {
					t.Fatalf("case %s should fail-closed on accepted 2xx receipt, got RecoveryOutcome=%q", tc.name, *stored.RecoveryOutcome)
				}
				if view.Outcome == nil || *view.Outcome != wantRetrievable {
					t.Fatalf("case %s Outcome = %+v, want %+v", tc.name, view.Outcome, wantRetrievable)
				}
			}
		})
	}
}
