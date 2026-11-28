package operations

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/transcription"
)

type transcribeTestDomain struct {
	*mediaDomain
	localBaseURL string
	cloudBaseURL string
	cloudAPIKey  string
	forceModel   string
}

func (d *transcribeTestDomain) ResolveMediaTranscriptionClient(_ context.Context, modelID string) (*transcription.Client, error) {
	effective := strings.TrimSpace(modelID)
	if effective == "" && d.forceModel != "" {
		effective = d.forceModel
	}
	if effective == "" {
		return transcription.NewClient(d.localBaseURL), nil
	}
	c := transcription.NewClient(d.cloudBaseURL)
	c.Model = effective
	c.APIKey = d.cloudAPIKey
	return c, nil
}

func openTranscribeTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := db.AutoMigrate(
		&model.AssistantProductionMandate{},
		&model.AssistantMandateReservation{},
		&model.AgentOpRecord{},
		&model.AssistantTurn{},
		&model.Task{},
	); err != nil {
		t.Fatal(err)
	}
	return db
}

func newWhisperLoopback(t *testing.T, expectedPath, expectedAuth, expectedModel string, failOnce *atomic.Bool, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != expectedPath {
			t.Errorf("unexpected path %q, want %q", r.URL.Path, expectedPath)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if expectedAuth != "" && r.Header.Get("Authorization") != expectedAuth {
			t.Errorf("unexpected auth %q", r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Errorf("parse multipart: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if expectedModel != "" && r.FormValue("model") != expectedModel {
			t.Errorf("model = %q, want %q", r.FormValue("model"), expectedModel)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if failOnce != nil && failOnce.CompareAndSwap(true, false) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("upstream failed"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"language": "zh",
			"segments": []map[string]any{
				{"start": 0.0, "end": 1.25, "text": "第一句旁白"},
				{"start": 1.25, "end": 2.0, "text": "第二句台词"},
			},
		})
	}))
}

func TestMediaTranscribeFreeLocalWhisperRunsWithoutMandate(t *testing.T) {
	audioData := nativeMediaFixture(t, true, false)
	var localCalls atomic.Int32
	localSrv := newWhisperLoopback(t, "/inference", "", "", nil, &localCalls)
	defer localSrv.Close()

	db := openTranscribeTestDB(t)
	store := NewStore(db)
	d := &transcribeTestDomain{
		mediaDomain:  &mediaDomain{owner: "owner", data: audioData, mimeType: "video/mp4"},
		localBaseURL: localSrv.URL,
	}
	// Read-only assistant caller WITHOUT any ProductionMandate must succeed on free local Whisper.
	ctx := &Context{
		Context: context.Background(),
		UserID:  "owner",
		TurnID:  "turn-local-1",
		Caller:  Caller{Kind: CallerAssistant, ReadOnly: true},
		Domain:  d,
		Store:   store,
	}
	raw, _ := json.Marshal(mediaTranscribeArgs{CanvasID: "canvas", NodeID: "node", Language: "zh"})
	res, err := runMediaTranscribe(ctx, raw)
	if err != nil {
		t.Fatalf("free local whisper failed: %v", err)
	}
	if localCalls.Load() != 1 {
		t.Fatalf("local calls = %d, want 1", localCalls.Load())
	}
	out := res.(map[string]any)
	if out["mode"] != "local" || out["language"] != "zh" {
		t.Fatalf("unexpected local output: %+v", out)
	}
	segs := out["segments"].([]transcription.Segment)
	if len(segs) != 2 || segs[0].Text != "第一句旁白" || segs[1].StartMs != 1250 {
		t.Fatalf("unexpected segments: %+v", segs)
	}
	srt := out["srt"].(string)
	if !strings.Contains(srt, "00:00:00,000 --> 00:00:01,250") || !strings.Contains(srt, "第二句台词") {
		t.Fatalf("unexpected srt: %q", srt)
	}
	// Precheck also allows free local Whisper immediately.
	precheck, err := EvaluatePaidToolPrecheckInTx(db, d, "owner", ToolPrecheckRequest{
		CanvasID: "canvas",
		TurnID:   "turn-local-1",
		ToolName: "media_transcribe",
		OpName:   "media.transcribe",
		CallID:   "call-local",
		Params:   raw,
	})
	if err != nil || precheck.Decision != "allow" || precheck.Reason != "local_whisper_free" {
		t.Fatalf("local precheck = %+v err=%v", precheck, err)
	}
}

func TestMediaTranscribePaidCloudWhisperMandateAndRaceEnforcement(t *testing.T) {
	audioData := nativeMediaFixture(t, true, false)
	var cloudCalls atomic.Int32
	var failFirst atomic.Bool
	failFirst.Store(true)
	cloudSrv := newWhisperLoopback(t, "/v1/audio/transcriptions", "Bearer cloud-key", "whisper-large-v3", &failFirst, &cloudCalls)
	defer cloudSrv.Close()

	db := openTranscribeTestDB(t)
	store := NewStore(db)
	if err := db.Create(&model.AssistantTurn{
		TurnID: "turn-cloud-1", UserID: "owner", CanvasID: "canvas", DurableSessionID: "sess-1", State: "open",
	}).Error; err != nil {
		t.Fatal(err)
	}
	d := &transcribeTestDomain{
		mediaDomain:  &mediaDomain{owner: "owner", data: audioData, mimeType: "video/mp4"},
		cloudBaseURL: cloudSrv.URL,
		cloudAPIKey:  "cloud-key",
	}
	cloudParams, _ := json.Marshal(mediaTranscribeArgs{CanvasID: "canvas", NodeID: "node", Model: "whisper-large-v3"})

	// 1. Read-only caller must be rejected BEFORE any upstream call.
	roCtx := &Context{
		Context: context.Background(),
		UserID:  "owner",
		TurnID:  "turn-cloud-1",
		Caller:  Caller{Kind: CallerAssistant, ReadOnly: true},
		Domain:  d,
		Store:   store,
	}
	if _, err := runMediaTranscribe(roCtx, cloudParams); AsError(err) == nil || AsError(err).Reason != "read_only_client" {
		t.Fatalf("read-only cloud transcribe must fail with read_only_client, got %v", err)
	}
	if cloudCalls.Load() != 0 {
		t.Fatalf("rejected read-only call hit cloud whisper: %d", cloudCalls.Load())
	}

	// 2. Assistant WITHOUT active mandate must fail closed (approval_required) AND precheck must require approval.
	precheck, err := EvaluatePaidToolPrecheckInTx(db, d, "owner", ToolPrecheckRequest{
		CanvasID: "canvas", SessionID: "sess-1", TurnID: "turn-cloud-1",
		ToolName: "media_transcribe", OpName: "media.transcribe", CallID: "call-cloud-1",
		Params: cloudParams,
	})
	if err != nil || precheck.Decision != "approval_required" || len(precheck.Kinds) != 1 || precheck.Kinds[0] != model.MandateKindMediaTranscribe {
		t.Fatalf("cloud precheck without mandate = %+v err=%v", precheck, err)
	}
	assistantCtx := &Context{
		Context: context.Background(),
		UserID:  "owner",
		TurnID:  "turn-cloud-1",
		Caller:  Caller{Kind: CallerAssistant},
		Domain:  d,
		Store:   store,
	}
	if _, err := runMediaTranscribe(assistantCtx, cloudParams); AsError(err) == nil || AsError(err).Reason != "approval_required" {
		t.Fatalf("unmandated cloud transcribe must fail with approval_required, got %v", err)
	}
	if cloudCalls.Load() != 0 {
		t.Fatalf("unmandated cloud call hit upstream: %d", cloudCalls.Load())
	}

	// 3. Even if args.Model == "", a workspace resolver forcing a paid cloud model MUST still hit the billing gate!
	dForced := *d
	dForced.forceModel = "whisper-large-v3"
	forcedCtx := *assistantCtx
	forcedCtx.Domain = &dForced
	emptyModelParams, _ := json.Marshal(mediaTranscribeArgs{CanvasID: "canvas", NodeID: "node"})
	if _, err := runMediaTranscribe(&forcedCtx, emptyModelParams); AsError(err) == nil || AsError(err).Reason != "approval_required" {
		t.Fatalf("workspace-forced cloud model bypassed mandate gate: %v", err)
	}

	// 4. Create an active ProductionMandate allowing exactly 1 unquoted media_transcribe call.
	mandate, err := CreateProductionMandateInTx(db, "owner", CreateProductionMandateInput{
		CanvasID:         "canvas",
		SessionID:        "sess-1",
		MaxAmountCNY:     20,
		MaxUnquotedCount: 1,
		AllowedKinds:     []string{model.MandateKindMediaTranscribe},
		ApprovedBy:       "owner",
	})
	if err != nil {
		t.Fatal(err)
	}

	// First cloud attempt hits 502 -> permit MUST be released so slot returns to 1.
	if _, err := runMediaTranscribe(assistantCtx, cloudParams); err == nil {
		t.Fatal("expected 502 cloud error on first attempt")
	}
	afterFail, err := GetProductionMandateInTx(db, "owner", mandate.ID)
	if err != nil || afterFail.UsedUnquotedCount != 0 {
		t.Fatalf("failed cloud transcribe did not release permit: %+v err=%v", afterFail, err)
	}

	// 5. Concurrent race: 4 goroutines compete for the 1 remaining unquoted slot -> exactly 1 succeeds!
	var wg sync.WaitGroup
	var succeeded atomic.Int32
	var blocked atomic.Int32
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ctxCopy := *assistantCtx
			res, callErr := runMediaTranscribe(&ctxCopy, cloudParams)
			if callErr == nil && res != nil {
				succeeded.Add(1)
			} else {
				blocked.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if succeeded.Load() != 1 || blocked.Load() != 3 {
		t.Fatalf("concurrent mandate ceiling violated: succeeded=%d blocked=%d", succeeded.Load(), blocked.Load())
	}
	finalMandate, err := GetProductionMandateInTx(db, "owner", mandate.ID)
	if err != nil || finalMandate.UsedUnquotedCount != 1 {
		t.Fatalf("mandate accounting wrong after settlement: %+v err=%v", finalMandate, err)
	}
}

func TestMediaTranscribeRejectsNonAudioVideoImage(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	d := &mediaDomain{owner: "owner", data: buf.Bytes(), mimeType: "image/png"}
	ctx := &Context{Context: context.Background(), UserID: "owner", Domain: d}
	raw, _ := json.Marshal(mediaTranscribeArgs{CanvasID: "canvas", NodeID: "node"})
	if _, err := runMediaTranscribe(ctx, raw); AsError(err) == nil || AsError(err).Reason != "media_transcribe_unsupported_mime" {
		t.Fatalf("expected media_transcribe_unsupported_mime for image, got %v", err)
	}
}
