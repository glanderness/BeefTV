package playback

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type syncRunner struct{}

func (syncRunner) Go(fn func()) bool {
	if fn != nil {
		fn()
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
	svc.Backfill()

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
		Transcode: func(src, dst string) error {
			writeCodecMP4(t, dst, "avc1")
			copied <- struct{}{}
			return nil
		},
	})
	svc.Backfill()
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
		Transcode: func(src, dst string) error {
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
