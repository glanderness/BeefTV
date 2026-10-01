package playback

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

type syncRunner struct{}

func TestBackfillDoesNotResetClaimStartedByThisRuntime(t *testing.T) {
	store := &memStore{}
	svc := New(Deps{Store: store})
	if err := svc.Recover(); err != nil {
		t.Fatal(err)
	}
	store.put(model.Resource{ID: "in-flight", UserID: "user-1", Status: model.ResourceStatusReady, Kind: "video", Provider: "local", PlaybackStatus: model.PlaybackStatusProcessing})
	if err := svc.Backfill(context.Background()); err != nil {
		t.Fatal(err)
	}
	row, _ := store.ResourceForUser("user-1", "in-flight")
	if row.PlaybackStatus != model.PlaybackStatusProcessing {
		t.Fatalf("live claim reset: %s", row.PlaybackStatus)
	}
}

func TestRuntimeContextRefusesWorkBeforeStartAndAfterStop(t *testing.T) {
	store := &memStore{}
	var owned context.Context
	svc := New(Deps{Store: store, RuntimeContext: func() context.Context { return owned }})
	if !errors.Is(svc.Backfill(nil), context.Canceled) {
		t.Fatal("work accepted before start")
	}
	owned = context.Background()
	if err := svc.Backfill(nil); err != nil {
		t.Fatal(err)
	}
	owned = nil
	if !errors.Is(svc.Backfill(nil), context.Canceled) {
		t.Fatal("work accepted after stop")
	}
}

func (syncRunner) Go(fn func(context.Context)) bool {
	if fn != nil {
		fn(context.Background())
	}
	return true
}

type rejectRunner struct{ calls int }

func (r *rejectRunner) Go(fn func(context.Context)) bool {
	r.calls++
	return false
}

type ctxRunner struct{ ctx context.Context }

func (r ctxRunner) Go(fn func(context.Context)) bool {
	if fn != nil {
		fn(r.ctx)
	}
	return true
}

func writeCodecMP4(t *testing.T, path, fourcc string) {
	t.Helper()
	stsd := stsdBoxWithFourcc(fourcc)
	moov := make([]byte, 8+len(stsd))
	binary.BigEndian.PutUint32(moov[0:4], uint32(len(moov)))
	copy(moov[4:8], "moov")
	copy(moov[8:], stsd)
	ftyp := make([]byte, 16)
	binary.BigEndian.PutUint32(ftyp[0:4], 16)
	copy(ftyp[4:8], "ftyp")
	copy(ftyp[8:12], "isom")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(append([]byte{}, ftyp...), moov...), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestOpenRangeServesJailedPlaybackCopy(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	resource := model.Resource{
		ID: "res-range", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "res-range.mp4",
	}
	store.put(resource)
	payload := []byte("playback-bytes")
	path := filepath.Join(dataDir, DirName, "res-range.mp4")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatal(err)
	}

	svc := New(Deps{DataDir: dataDir, Store: store})
	stream, err := svc.OpenRange("user-1", "res-range")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	got, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("body = %q, want %q", got, payload)
	}
	if stream.Resource.MimeType != "video/mp4" {
		t.Fatalf("mime = %q", stream.Resource.MimeType)
	}
	if stream.AcceptRanges != "bytes" {
		t.Fatalf("accept-ranges = %q", stream.AcceptRanges)
	}
}

func TestOpenRangeRejectsPathEscape(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	store.put(model.Resource{
		ID: "res-escape", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "../secret.mp4",
	})
	svc := New(Deps{DataDir: dataDir, Store: store})
	if _, err := svc.OpenRange("user-1", "res-escape"); err == nil {
		t.Fatal("escaped playback key must be rejected")
	}
}

func TestOpenRangeRequiresReadyLocalCopy(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	store.put(model.Resource{
		ID: "res-pending", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", PlaybackStatus: model.PlaybackStatusProcessing,
	})
	svc := New(Deps{DataDir: dataDir, Store: store})
	if _, err := svc.OpenRange("user-1", "res-pending"); !errors.Is(err, ErrNotReady) {
		t.Fatalf("err = %v, want ErrNotReady", err)
	}
}

func TestBackfillResetsCrashLeftoverClaim(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "stuck.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "avc1")
	store.put(model.Resource{
		ID: "stuck", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel, PlaybackStatus: model.PlaybackStatusProcessing,
		PlaybackError: "interrupted",
	})

	svc := New(Deps{DataDir: dataDir, Store: store, Runner: syncRunner{}, LookPath: func(string) (string, error) {
		return "ffmpeg", nil
	}})
	if err := svc.Backfill(context.Background()); err != nil {
		t.Fatal(err)
	}

	got := store.get("stuck")
	if got == nil {
		t.Fatal("missing resource")
	}
	if got.PlaybackStatus != model.PlaybackStatusNone {
		t.Fatalf("stuck claim after backfill = %q, want none (H.264 rejudged)", got.PlaybackStatus)
	}
	if got.PlaybackError != "" {
		t.Fatalf("leftover error = %q", got.PlaybackError)
	}
}

func TestBackfillRejudgesLegacyNoneMPEG4(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "legacy-mpeg4.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "mp4v")
	store.put(model.Resource{
		ID: "legacy-mpeg4", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel, PlaybackStatus: model.PlaybackStatusNone,
	})

	copied := make(chan struct{}, 1)
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  syncRunner{},
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			writeCodecMP4(t, dst, "avc1")
			copied <- struct{}{}
			return nil
		},
	})
	if err := svc.Backfill(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-copied:
	default:
		t.Fatal("legacy MPEG-4 none row was not reclaimed for transcode")
	}
	got := store.get("legacy-mpeg4")
	if got.PlaybackStatus != model.PlaybackStatusReady {
		t.Fatalf("status = %q, want ready", got.PlaybackStatus)
	}
	if got.PlaybackObjectKey != "legacy-mpeg4.mp4" {
		t.Fatalf("object key = %q", got.PlaybackObjectKey)
	}
}

func TestMaybeStartClaimsOnce(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	resource := model.Resource{
		ID: "hevc", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	}
	store.put(resource)

	var mu sync.Mutex
	starts := 0
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  syncRunner{},
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			mu.Lock()
			starts++
			mu.Unlock()
			writeCodecMP4(t, dst, "avc1")
			return nil
		},
	})
	first := resource
	svc.MaybeStart(&first)
	second := resource
	second.PlaybackStatus = ""
	svc.MaybeStart(&second)
	if starts != 1 {
		t.Fatalf("transcode starts = %d, want 1", starts)
	}
}

func TestSourcePathRejectsTraversal(t *testing.T) {
	svc := New(Deps{DataDir: t.TempDir()})
	if _, err := svc.sourcePath("../etc/passwd"); err == nil {
		t.Fatal("traversal object key must be rejected")
	}
}

func TestFixtureTranscodeAndOpenRange(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dataDir := t.TempDir()
	rel := filepath.Join("clips", "mpeg4.mp4")
	src := filepath.Join(dataDir, "resources", rel)
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc=duration=0.2:size=64x64:rate=10",
		"-c:v", "mpeg4", "-an", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("cannot generate MPEG-4 fixture: %v\n%s", err, out)
	}
	if ProbeCodec(src) != CodecMPEG4 {
		t.Fatalf("generated codec = %q, want mpeg4", ProbeCodec(src))
	}
	store := &memStore{}
	store.put(model.Resource{
		ID: "mpeg4", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	svc := New(Deps{DataDir: dataDir, Store: store, Runner: syncRunner{}})
	svc.MaybeStart(store.get("mpeg4"))
	got := store.get("mpeg4")
	if got.PlaybackStatus != model.PlaybackStatusReady {
		t.Fatalf("transcode status = %q error=%q", got.PlaybackStatus, got.PlaybackError)
	}
	if ProbeCodec(filepath.Join(dataDir, DirName, "mpeg4.mp4")) != CodecH264 {
		t.Fatal("playback copy is not H.264")
	}
	stream, err := svc.OpenRange("user-1", "mpeg4")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	body, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) == 0 {
		t.Fatal("playback copy was empty")
	}
}

func TestRunnerRejectReleasesClaim(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	store.put(model.Resource{
		ID: "hevc-reject", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	runner := &rejectRunner{}
	started := 0
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  runner,
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			started++
			return nil
		},
	})
	svc.MaybeStart(store.get("hevc-reject"))
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d", runner.calls)
	}
	if started != 0 {
		t.Fatal("rejected runner still started transcode")
	}
	got := store.get("hevc-reject")
	if got.PlaybackStatus != "" {
		t.Fatalf("rejected claim left status %q, want empty for restart recovery", got.PlaybackStatus)
	}
}

func TestCancelDoesNotPersistReady(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc-cancel.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	store.put(model.Resource{
		ID: "hevc-cancel", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := 0
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  ctxRunner{ctx: ctx},
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			started++
			writeCodecMP4(t, dst, "avc1")
			return nil
		},
	})
	svc.MaybeStart(store.get("hevc-cancel"))
	if started != 0 {
		t.Fatal("canceled context started ffmpeg")
	}
	got := store.get("hevc-cancel")
	if got.PlaybackStatus == model.PlaybackStatusReady {
		t.Fatal("canceled transcode wrote READY")
	}
	if got.PlaybackStatus != "" {
		t.Fatalf("canceled transcode status = %q, want released claim", got.PlaybackStatus)
	}
}

func TestCancelDuringTranscodeReleasesClaim(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc-mid.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	store.put(model.Resource{
		ID: "hevc-mid", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	ctx, cancel := context.WithCancel(context.Background())
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  ctxRunner{ctx: ctx},
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(runCtx context.Context, src, dst string) error {
			writeCodecMP4(t, dst, "avc1")
			cancel()
			return runCtx.Err()
		},
	})
	svc.MaybeStart(store.get("hevc-mid"))
	got := store.get("hevc-mid")
	if got.PlaybackStatus == model.PlaybackStatusReady {
		t.Fatal("mid-transcode cancel wrote READY")
	}
	if got.PlaybackStatus != "" {
		t.Fatalf("status = %q, want released claim", got.PlaybackStatus)
	}
	if _, err := os.Stat(filepath.Join(dataDir, DirName, "hevc-mid.mp4")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled copy should be removed, err=%v", err)
	}
}

func TestSuccessfulTranscodeDoesNotResurrectDeletedResource(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc-del.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	store.put(model.Resource{
		ID: "hevc-del", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  syncRunner{},
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			store.setStatus("hevc-del", model.ResourceStatusPending)
			writeCodecMP4(t, dst, "avc1")
			return nil
		},
	})
	svc.MaybeStart(store.get("hevc-del"))
	got := store.get("hevc-del")
	if got.Status != model.ResourceStatusPending {
		t.Fatalf("status = %s", got.Status)
	}
	if got.PlaybackStatus == model.PlaybackStatusReady {
		t.Fatal("deleted/non-READY row was resurrected as playback READY")
	}
}

func TestBackfillResetErrorStopsScan(t *testing.T) {
	store := &resetFailStore{err: errors.New("reset failed")}
	pending := 0
	store.pending = func() { pending++ }
	svc := New(Deps{Store: store, Runner: syncRunner{}})
	if err := svc.Backfill(context.Background()); err == nil {
		t.Fatal("expected reset error")
	}
	if pending != 0 {
		t.Fatalf("pending listed after reset failure: %d", pending)
	}
}

func TestBackfillPendingFetchError(t *testing.T) {
	store := &pageFailStore{pendingErr: errors.New("pending query failed")}
	svc := New(Deps{Store: store, Runner: syncRunner{}})
	if err := svc.Backfill(context.Background()); err == nil {
		t.Fatal("expected pending fetch error")
	}
}

func TestBackfillNoneCursorCoversMoreThanOneBatch(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	probed := 0
	for i := 0; i < backfillBatch+5; i++ {
		id := "none-" + string(rune('a'+i))
		rel := filepath.Join("clips", id+".mp4")
		writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "avc1")
		store.put(model.Resource{
			ID: id, UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: rel, PlaybackStatus: model.PlaybackStatusNone,
			CreatedAt: time.Unix(int64(i+1), 0),
		})
	}
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  syncRunner{},
		LookPath: func(string) (string, error) {
			probed++
			return "ffmpeg", nil
		},
	})
	if err := svc.Backfill(context.Background()); err != nil {
		t.Fatal(err)
	}
	if probed != backfillBatch+5 {
		t.Fatalf("probed = %d, want %d", probed, backfillBatch+5)
	}
}

func TestBackfillMarkNoneFailureStillAdvances(t *testing.T) {
	dataDir := t.TempDir()
	inner := &memStore{}
	for i, id := range []string{"p1", "p2"} {
		rel := filepath.Join("clips", id+".mp4")
		writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "avc1")
		inner.put(model.Resource{
			ID: id, UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: rel, CreatedAt: time.Unix(int64(i+1), 0),
		})
	}
	store := &markNoneFailStore{memStore: inner, pages: 0}
	svc := New(Deps{
		DataDir:  dataDir,
		Store:    store,
		Runner:   syncRunner{},
		LookPath: func(string) (string, error) { return "ffmpeg", nil },
	})
	done := make(chan error, 1)
	go func() { done <- svc.Backfill(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("backfill looped on mark-none failure")
	}
	if store.pages < 2 {
		t.Fatalf("pages = %d, want cursor to fetch a following empty page", store.pages)
	}
}

func TestMaybeStartCanceledContextDoesNotClaim(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc-stopped.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	store.put(model.Resource{
		ID: "hevc-stopped", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runner := &rejectRunner{}
	started := 0
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  runner,
		Context: ctx,
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			started++
			return nil
		},
	})
	svc.MaybeStart(store.get("hevc-stopped"))
	if runner.calls != 0 {
		t.Fatalf("stopped runtime still called runner: %d", runner.calls)
	}
	if started != 0 {
		t.Fatal("stopped runtime started transcode")
	}
	got := store.get("hevc-stopped")
	if got.PlaybackStatus != "" {
		t.Fatalf("status = %q, want unclaimed", got.PlaybackStatus)
	}
}

func TestRunnerNilDoesNotClaim(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	rel := filepath.Join("clips", "hevc-nil.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	store.put(model.Resource{
		ID: "hevc-nil", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel,
	})
	started := 0
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			started++
			return nil
		},
	})
	svc.MaybeStart(store.get("hevc-nil"))
	if started != 0 {
		t.Fatal("nil runner started transcode")
	}
	got := store.get("hevc-nil")
	if got.PlaybackStatus != "" {
		t.Fatalf("status = %q, want unclaimed", got.PlaybackStatus)
	}
}

func TestBackfillRejectRunnerReleasesClaimsAndAdvances(t *testing.T) {
	dataDir := t.TempDir()
	store := &memStore{}
	for i, id := range []string{"hevc-a", "hevc-b"} {
		rel := filepath.Join("clips", id+".mp4")
		writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
		store.put(model.Resource{
			ID: id, UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: rel, CreatedAt: time.Unix(int64(i+1), 0),
		})
	}
	runner := &rejectRunner{}
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  runner,
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
		Transcode: func(ctx context.Context, src, dst string) error {
			t.Fatal("rejected runner must not transcode")
			return nil
		},
	})
	done := make(chan error, 1)
	go func() { done <- svc.Backfill(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("backfill looped after runner rejection")
	}
	if runner.calls != 2 {
		t.Fatalf("runner calls = %d, want 2", runner.calls)
	}
	for _, id := range []string{"hevc-a", "hevc-b"} {
		got := store.get(id)
		if got.PlaybackStatus != "" {
			t.Fatalf("%s status = %q, want released claim", id, got.PlaybackStatus)
		}
	}
}

type claimFailStore struct {
	*memStore
	err   error
	calls int
}

func (s *claimFailStore) ClaimPlaybackTranscode(id string) (bool, error) {
	s.calls++
	return false, s.err
}

func TestBackfillClaimErrorDoesNotLoop(t *testing.T) {
	dataDir := t.TempDir()
	inner := &memStore{}
	rel := filepath.Join("clips", "hevc-claim.mp4")
	writeCodecMP4(t, filepath.Join(dataDir, "resources", rel), "hvc1")
	inner.put(model.Resource{
		ID: "hevc-claim", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel, CreatedAt: time.Unix(1, 0),
	})
	store := &claimFailStore{memStore: inner, err: errors.New("claim refused")}
	svc := New(Deps{
		DataDir: dataDir,
		Store:   store,
		Runner:  syncRunner{},
		LookPath: func(string) (string, error) {
			return "ffmpeg", nil
		},
	})
	done := make(chan error, 1)
	go func() { done <- svc.Backfill(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("backfill looped on claim error")
	}
	if store.calls == 0 {
		t.Fatal("claim was not attempted")
	}
	got := store.get("hevc-claim")
	if got.PlaybackStatus == model.PlaybackStatusProcessing || got.PlaybackStatus == model.PlaybackStatusReady {
		t.Fatalf("status = %q after claim error", got.PlaybackStatus)
	}
}

func TestBackfillHonorsCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := &memStore{}
	svc := New(Deps{Store: store, Runner: syncRunner{}, Context: ctx})
	if err := svc.Backfill(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

type resetFailStore struct {
	memStore
	err     error
	pending func()
}

func (s *resetFailStore) ResetStuckPlaybackTranscodes() error { return s.err }
func (s *resetFailStore) PlaybackPendingVideos(afterCreatedAt time.Time, afterID string, limit int) ([]model.Resource, error) {
	if s.pending != nil {
		s.pending()
	}
	return s.memStore.PlaybackPendingVideos(afterCreatedAt, afterID, limit)
}

type pageFailStore struct {
	memStore
	pendingErr error
}

func (s *pageFailStore) PlaybackPendingVideos(time.Time, string, int) ([]model.Resource, error) {
	return nil, s.pendingErr
}

type markNoneFailStore struct {
	*memStore
	pages int
}

func (s *markNoneFailStore) MarkPlaybackNone(id string) (bool, error) {
	return false, errors.New("db busy")
}

func (s *markNoneFailStore) PlaybackPendingVideos(afterCreatedAt time.Time, afterID string, limit int) ([]model.Resource, error) {
	s.pages++
	return s.memStore.PlaybackPendingVideos(afterCreatedAt, afterID, limit)
}
