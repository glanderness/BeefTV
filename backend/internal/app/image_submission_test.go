package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func imageSubmissionFixture(t *testing.T, multipartBody bool) (*Service, *gorm.DB, model.Task, *model.ImageSubmission, []byte) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	s.workerID = newID()
	task := model.Task{ID: "image-task", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning, LeaseOwner: "owner", InputJSON: `{"mode":"image"}`}
	expires := time.Now().Add(time.Hour)
	task.LeaseExpiresAt = &expires
	attempt := &model.RouteAttempt{ID: "image-attempt", TaskID: task.ID, Status: "dispatching", DispatchState: "submission_unknown", StartedAt: time.Now()}
	for _, row := range []any{&task, attempt} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	body := []byte(`{"model":"gpt-image-2","prompt":"a boat","n":1}`)
	contentType, path := "application/json", "/v1/images/generations"
	if multipartBody {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		_ = writer.WriteField("prompt", "the exact image")
		part, _ := writer.CreateFormFile("image", "original.png")
		_, _ = part.Write([]byte("immutable image bytes"))
		_ = writer.Close()
		body, contentType, path = buffer.Bytes(), writer.FormDataContentType(), "/v1/images/edits"
	}
	ctx := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s, task), attempt)
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://enterprise.beefapi.com"+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer private-test-key")
	req.Header.Set("X-Idempotency-Key", "must-not-override-owner")
	_, row, handled, err := prepareImageSubmission(req)
	if err != nil || !handled {
		t.Fatalf("prepare: handled=%v err=%v", handled, err)
	}
	if strings.Contains(row.RequestCipher, "private-test-key") || strings.Contains(row.RequestCipher, "boat") {
		t.Fatal("plaintext persisted")
	}
	t.Cleanup(func() {
		providerAnalyticsServices.Lock()
		delete(providerAnalyticsServices.services, s.workerID)
		providerAnalyticsServices.Unlock()
	})
	return s, db, task, row, body
}

func noImageWait(context.Context, time.Duration) error { return nil }

func TestImageSubmissionConfirmedThrottleRetriesFrozenRequestOnlyThreeTimes(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, true)
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	attempt.AttemptNumber = 1
	if err := db.Save(attempt).Error; err != nil {
		t.Fatal(err)
	}
	priorPlain, _ := s.decryptSettingSecret(row.RequestCipher)
	var priorWire imageWireRequest
	_ = json.Unmarshal([]byte(priorPlain), &priorWire)
	seen := map[string]bool{priorWire.Header.Get("Idempotency-Key"): true}
	for i := 1; i <= 3; i++ {
		throttled := providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`}
		s.finishTaskRouteAttempt(attempt, &task, throttled)
		next, err := s.nextRouteAttemptAfterFailure(&task, attempt, throttled)
		if err != nil {
			t.Fatal(err)
		}
		if i == 3 {
			if next != nil {
				t.Fatal("fourth paid attempt created")
			}
			break
		}
		if next == nil || next.AttemptNumber != i+1 {
			t.Fatalf("next=%+v", next)
		}
		snapshot, err := s.repo.ImageSubmission(next.ID, task.ID, task.UserID)
		if err != nil {
			t.Fatal(err)
		}
		plain, _ := s.decryptSettingSecret(snapshot.RequestCipher)
		var wire imageWireRequest
		_ = json.Unmarshal([]byte(plain), &wire)
		key := wire.Header.Get("Idempotency-Key")
		if key == "" || seen[key] || !bytes.Equal(wire.Body, priorWire.Body) || wire.URL != priorWire.URL || wire.Header.Get("Authorization") != priorWire.Header.Get("Authorization") {
			t.Fatal("new attempt changed input or reused terminal key")
		}
		seen[key] = true
		attempt = next
	}
}

func TestImageSubmissionLostResponsePendingAndReplay(t *testing.T) {
	for _, multipartBody := range []bool{false, true} {
		t.Run(map[bool]string{false: "generation", true: "edit"}[multipartBody], func(t *testing.T) {
			s, _, task, row, body := imageSubmissionFixture(t, multipartBody)
			calls, key := 0, ""
			data, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(req *http.Request) ([]byte, string, error) {
				calls++
				got, _ := io.ReadAll(req.Body)
				if !bytes.Equal(got, body) {
					t.Fatal("request body changed")
				}
				if req.Header.Get("X-Idempotency-Key") != "" {
					t.Fatal("conflicting key retained")
				}
				if calls == 1 {
					key = req.Header.Get("Idempotency-Key")
				}
				if key == "" || req.Header.Get("Idempotency-Key") != key {
					t.Fatal("submission key changed")
				}
				switch calls {
				case 1:
					return nil, "", io.ErrUnexpectedEOF
				case 2:
					return nil, "", providerHTTPError{StatusCode: 409, Body: `{"error":{"code":"image_submission_pending"}}`, IdempotencyReplayed: true}
				default:
					return []byte(`{"data":[{"b64_json":"cG5n"}]}`), "application/json", nil
				}
			}, noImageWait)
			if err != nil || calls != 3 || len(data) == 0 {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
			persisted, _ := s.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
			if persisted.SendCount != 3 {
				t.Fatalf("durable send count=%d", persisted.SendCount)
			}
		})
	}
}

func TestImageSubmissionRestartKeepsWireAndBudget(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, true)
	if err := s.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, imageRecoveryMaxSends); err != nil {
		t.Fatal(err)
	}
	// A fresh service decrypts the original durable wire request, independent of
	// mutable task configuration, protocol packages, or deleted reference files.
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir}
	attempt, err := restarted.beginTaskRouteAttempt(&task)
	if err != nil || attempt.ID != row.AttemptID {
		t.Fatalf("attempt=%v err=%v", attempt, err)
	}
	loaded, _ := restarted.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if loaded.SendCount != 1 {
		t.Fatal("restart reset request budget")
	}
	loaded.CreatedAt = time.Now().Add(-2 * time.Hour)
	_, _, err = restarted.sendImageSubmissionWith(context.Background(), task, loaded, func(req *http.Request) ([]byte, string, error) {
		got, _ := io.ReadAll(req.Body)
		if !bytes.Equal(got, body) {
			t.Fatal("restart rebuilt request")
		}
		return []byte(`{"data":[{"b64_json":"cG5n"}]}`), "application/json", nil
	}, noImageWait)
	if err != nil {
		t.Fatal(err)
	}
}

func TestImageSubmissionTerminalResponsesNeverRegenerate(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		code      string
		uncertain bool
	}{
		{"unknown", 409, "image_result_unknown", true}, {"expired", 410, "image_result_expired", true}, {"conflict", 409, "idempotency_conflict", true},
		{"invalid", 400, "invalid_params", false}, {"balance", 402, "insufficient_quota", false}, {"auth", 401, "invalid_api_key", false}, {"moderation", 403, "content_policy_violation", false}, {"throttled", 429, "rate_limit_exceeded", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, task, row, _ := imageSubmissionFixture(t, false)
			calls := 0
			_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(*http.Request) ([]byte, string, error) {
				calls++
				return nil, "", providerHTTPError{StatusCode: tc.status, Body: `{"error":{"code":"` + tc.code + `"}}`}
			}, noImageWait)
			if err == nil || calls != 1 {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
			if tc.uncertain && classifyTaskFailure(err).Category != generation.CategorySubmissionUncertain {
				t.Fatalf("unsafe classification: %v", classifyTaskFailure(err))
			}
		})
	}
}

func TestImageSubmissionBudgetCancelAndOwnership(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	calls := 0
	send := func(*http.Request) ([]byte, string, error) { calls++; return nil, "", io.ErrUnexpectedEOF }
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends || classifyTaskFailure(err).Category != generation.CategorySubmissionUncertain {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	_, _, _ = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("budget reset")
	}
	row.SendCount = 0
	if err := db.Model(row).Update("send_count", 0).Error; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, _ = s.sendImageSubmissionWith(ctx, task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("cancel dispatched")
	}
	other := task
	other.UserID = "other"
	_, _, _ = s.sendImageSubmissionWith(context.Background(), other, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("wrong owner dispatched")
	}
	if err := db.Model(&task).Update("status", model.TaskStatusCancelled).Error; err != nil {
		t.Fatal(err)
	}
	_, _, _ = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if calls != imageRecoveryMaxSends {
		t.Fatal("cancelled row dispatched")
	}
	if _, err := s.RetryTask(task.UserID, task.ID); err == nil {
		t.Fatal("cancelled accepted image minted new key")
	}
	if err := s.validateRetryTaskType(task.UserID, task.Type, map[string]any{"metadata": map[string]any{"retryOf": task.ID}}); err == nil {
		t.Fatal("canvas retry bypassed the original submission guard")
	}
}

func TestImageSubmissionPermanentErrorsDoNotFallBackToAnotherRoute(t *testing.T) {
	s, _, task, _, _ := imageSubmissionFixture(t, false)
	task.LogicalModelID = "logical-image"
	attempt, _ := s.repo.LatestRouteAttempt(task.ID)
	attempt.AttemptNumber = 1
	attempt.DispatchState = "rejected_no_job"
	for _, status := range []int{400, 401, 402, 403, 404, 409, 410, 500} {
		next, err := s.nextRouteAttemptAfterFailure(&task, attempt, providerHTTPError{StatusCode: status})
		if err != nil || next != nil {
			t.Fatalf("status %d fell back: %v %v", status, next, err)
		}
	}
	if definiteImageThrottle(providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"insufficient_quota"}}`}) {
		t.Fatal("quota error treated as transient throttle")
	}
}

func TestImageSubmissionPersistenceRequiredAndScopeAllowlist(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	ctx := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s, task), &model.RouteAttempt{ID: row.AttemptID, TaskID: task.ID})
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://enterprise.beefapi.com/v1/images/generations", strings.NewReader(`{}`))
	_, _, handled, err := prepareImageSubmission(req)
	if !handled || err == nil {
		t.Fatal("storage failure did not fail closed")
	}
	for _, url := range []string{"http://enterprise.beefapi.com/v1/images/generations", "https://evil.beefapi.com/v1/images/generations", "https://beefapi.com.evil.test/v1/images/generations", "https://api.openai.com/v1/images/generations", "https://beefapi.com/v1/responses", "https://beefapi.com:8443/v1/images/edits"} {
		r, _ := http.NewRequest("POST", url, nil)
		if recoverableImageEndpoint(r) {
			t.Fatalf("unverified contract enabled: %s", url)
		}
	}
}

func TestImageSubmissionExpiredMalformedAndStaleLeaseStop(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	calls := 0
	send := func(*http.Request) ([]byte, string, error) {
		calls++
		return []byte(`{"data":[]}`), "application/json", nil
	}
	stale := task
	stale.LeaseOwner = "previous-process"
	_, _, err := s.sendImageSubmissionWith(context.Background(), stale, row, send, noImageWait)
	if err == nil || calls != 0 {
		t.Fatal("stale lease sent")
	}
	_, _, err = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	var unknown imageRecoveryError
	if !errors.As(err, &unknown) || calls != 1 {
		t.Fatalf("malformed response err=%v", err)
	}
	row.CreatedAt = time.Now().Add(-imageRecoveryLifetime - time.Minute)
	_, _, err = s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if err == nil || calls != 1 {
		t.Fatal("expired request replayed")
	}
	var stored model.ImageSubmission
	if err := db.First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(stored)
	if string(encoded) != "{}" {
		t.Fatal("snapshot fields exposed")
	}
}

func TestImageSubmissionConcurrentWorkersClaimOneSend(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	var admitted atomic.Int32
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			copy := *row
			if s.repo.ClaimImageSubmissionSend(&copy, task.LeaseOwner, imageRecoveryMaxSends) == nil {
				admitted.Add(1)
			}
		}()
	}
	workers.Wait()
	if admitted.Load() != 1 {
		t.Fatalf("concurrent sends admitted=%d", admitted.Load())
	}
}

func TestImageSubmissionNewAttemptAndSnapshotCommitTogether(t *testing.T) {
	s, db, task, _, _ := imageSubmissionFixture(t, false)
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	attempt := &model.RouteAttempt{ID: "must-rollback", TaskID: task.ID, AttemptNumber: 2}
	err := s.repo.CreateImageRetry(attempt, &model.ImageSubmission{AttemptID: attempt.ID, TaskID: task.ID, UserID: task.UserID})
	if err == nil {
		t.Fatal("missing snapshot table accepted")
	}
	var count int64
	if err := db.Model(&model.RouteAttempt{}).Where("id = ?", attempt.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("orphan attempt count=%d err=%v", count, err)
	}
}

func TestImageSubmissionLogicalThrottleAndRestartKeepFrozenRoute(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, true)
	task.LogicalModelID = "logical"
	task.RouteID = "route"
	attempt, _ := s.repo.LatestRouteAttempt(task.ID)
	attempt.AttemptNumber = 1
	attempt.LogicalModelID = "logical"
	attempt.RouteID = "route"
	attempt.ChannelID = "channel"
	s.finishTaskRouteAttempt(attempt, &task, providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`})
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir}
	next, err := restarted.beginTaskRouteAttempt(&task)
	if err != nil || next == nil || next.ID == row.AttemptID || next.AttemptNumber != 2 {
		t.Fatalf("restart next=%+v err=%v", next, err)
	}
	if next.RouteID != attempt.RouteID || next.ChannelID != attempt.ChannelID || next.LogicalModelID != attempt.LogicalModelID {
		t.Fatal("logical route changed")
	}
	frozen, err := s.repo.ImageSubmission(next.ID, task.ID, task.UserID)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := s.decryptSettingSecret(frozen.RequestCipher)
	var wire imageWireRequest
	_ = json.Unmarshal([]byte(plain), &wire)
	if !bytes.Equal(wire.Body, body) {
		t.Fatal("logical restart rebuilt wire")
	}
	s.finishTaskRouteAttempt(next, &task, providerHTTPError{StatusCode: 429})
	third, err := s.nextRouteAttemptAfterFailure(&task, next, providerHTTPError{StatusCode: 429})
	if err != nil || third == nil || third.AttemptNumber != 3 || third.RouteID != attempt.RouteID {
		t.Fatalf("logical continuation: %v %v", third, err)
	}
}

func TestImageSubmissionWorkerTimeoutAndLocalSaveFailureDeferSameAttempt(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	if err := s.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, imageRecoveryMaxSends); err != nil {
		t.Fatal(err)
	}
	if !s.shouldDeferImageRecovery(task, imageRecoveryError{context.DeadlineExceeded}, false) {
		t.Fatal("timeout lost resumable request")
	}
	if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
		t.Fatal(err)
	}
	if !s.shouldDeferImageRecovery(task, errors.New("disk full"), true) {
		t.Fatal("local save failure lost accepted request")
	}
	if s.shouldDeferImageRecovery(task, imageRecoveryError{context.Canceled}, false) {
		t.Fatal("cancel resumed")
	}
	if err := s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "正在恢复图片结果", 0); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.repo.ClaimNextTask("restarted-owner", time.Minute)
	if err != nil || claimed == nil || claimed.ID != task.ID {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	attempt, err := s.beginTaskRouteAttempt(claimed)
	if err != nil || attempt.ID != row.AttemptID {
		t.Fatalf("deferred attempt=%v err=%v", attempt, err)
	}
	if err := db.Model(row).Update("send_count", imageRecoveryMaxSends).Error; err != nil {
		t.Fatal(err)
	}
	if !s.shouldDeferImageRecovery(*claimed, errors.New("disk full"), true) {
		t.Fatal("accepted receipt was tied to uncertain request budget")
	}
	if err := db.Model(row).Update("response_accepted", false).Error; err != nil {
		t.Fatal(err)
	}
	if s.shouldDeferImageRecovery(*claimed, imageRecoveryError{context.DeadlineExceeded}, false) {
		t.Fatal("uncertain budget deferred forever")
	}
}

func TestImageSubmissionTwelfthSuccessSurvivesStorageFailure(t *testing.T) {
	s, db, task, row, body := imageSubmissionFixture(t, false)
	row.SendCount = 11
	if err := db.Model(row).Update("send_count", 11).Error; err != nil {
		t.Fatal(err)
	}
	key, calls := "", 0
	send := func(req *http.Request) ([]byte, string, error) {
		calls++
		actual, _ := io.ReadAll(req.Body)
		if !bytes.Equal(actual, body) {
			t.Fatal("accepted collection rebuilt body")
		}
		if key == "" {
			key = req.Header.Get("Idempotency-Key")
		}
		if req.Header.Get("Idempotency-Key") != key {
			t.Fatal("accepted collection changed key")
		}
		return []byte(`{"data":[{"b64_json":"` + strings.SplitN(testReferenceImageDataURL, ",", 2)[1] + `"}]}`), "application/json", nil
	}
	if _, _, err := s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait); err != nil {
		t.Fatal(err)
	}
	result := map[string]interface{}{"mode": "image", "images": []map[string]string{{"dataUrl": testReferenceImageDataURL}}}
	goodDir := s.dataDir
	badDir := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(badDir, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	s.dataDir = badDir
	_, saveErr := s.persistGeneratedMediaResult(task.UserID, result)
	s.dataDir = goodDir
	if saveErr == nil {
		t.Fatal("storage fault injection did not fail")
	}
	if !s.shouldDeferImageRecovery(task, saveErr, true) {
		t.Fatal("twelfth accepted response was abandoned")
	}
	if err := s.deferImageRecovery(task); err != nil {
		t.Fatal(err)
	}
	var waiting model.Task
	if err := db.First(&waiting, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if waiting.NextPollAt == nil || time.Until(*waiting.NextPollAt) < 14*time.Minute {
		t.Fatal("accepted result collection can busy loop")
	}
	if err := db.Model(&task).Update("next_poll_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err := s.repo.ClaimNextTask("new-owner", time.Minute)
	if err != nil || claimed == nil {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	loaded, err := s.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.sendImageSubmissionWith(context.Background(), *claimed, loaded, send, noImageWait); err != nil {
		t.Fatal(err)
	}
	if _, err := s.persistGeneratedMediaResult(task.UserID, result); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || loaded.SendCount != 13 {
		t.Fatalf("collection count=%d sends=%d", calls, loaded.SendCount)
	}
}

func TestImageSubmissionCachedFailureDoesNotSpendRecoveryBudget(t *testing.T) {
	err := providerHTTPError{StatusCode: 503, Body: `{"error":{"code":"internal_error"}}`, IdempotencyReplayed: true}
	if retrySameImageSubmission(err) {
		t.Fatal("cached terminal failure replayed repeatedly")
	}
}

func TestImageSubmissionDownloadThrottleCannotBecomeNewPaidAttempt(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
		t.Fatal(err)
	}
	attempt, _ := s.repo.LatestRouteAttempt(task.ID)
	attempt.AttemptNumber = 1
	downloadErr := providerHTTPError{StatusCode: 429}
	s.finishTaskRouteAttempt(attempt, &task, downloadErr)
	if attempt.DispatchState != "accepted" {
		t.Fatal("download failure erased acceptance")
	}
	if next, err := s.nextRouteAttemptAfterFailure(&task, attempt, downloadErr); err != nil || next != nil {
		t.Fatal("download throttle regenerated image")
	}
	if err := s.validateImageTaskRetry(&task); err == nil {
		t.Fatal("accepted image allowed paid retry")
	}
	if !s.shouldDeferImageRecovery(task, downloadErr, false) {
		t.Fatal("accepted image download throttle could not recover")
	}
	if !s.shouldDeferImageRecovery(task, providerHTTPError{StatusCode: 503}, false) {
		t.Fatal("accepted image download outage could not recover")
	}
	if s.shouldDeferImageRecovery(task, providerHTTPError{StatusCode: 403}, false) {
		t.Fatal("permanent download rejection retried forever")
	}
}
