package beeftv

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func makeMultipartFixtureBytes(parts, partSize int) []byte {
	data := make([]byte, parts*partSize)
	for i := range data {
		data[i] = byte((i*31 + i/partSize*17) & 0xff)
	}
	return data
}

type recordedProgressEvent struct {
	loaded int64
	total  int64
	phase  string
}

func assertMonotonicWithinAttempts(t *testing.T, events []recordedProgressEvent, total int64) {
	t.Helper()
	if len(events) < 2 {
		t.Fatalf("expected >=2 progress events, got %d", len(events))
	}
	prev := int64(-1)
	for i, ev := range events {
		if ev.total != total {
			t.Fatalf("event[%d].total = %d, want %d", i, ev.total, total)
		}
		if ev.loaded < 0 || ev.loaded > total {
			t.Fatalf("event[%d].loaded = %d out of [0, %d]", i, ev.loaded, total)
		}
		if ev.phase == "resuming" {
			prev = ev.loaded
			continue
		}
		if ev.loaded < prev {
			t.Fatalf("progress regressed within attempt at %d: %d < %d (events=%+v)", i, ev.loaded, prev, events)
		}
		prev = ev.loaded
	}
}

func TestMultipartUploadRunsFourPartsConcurrently(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 8
		partSize  = 64 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)
	digest := sha256.Sum256(data)
	hexDigest := hex.EncodeToString(digest[:])

	var (
		inFlight    atomic.Int64
		maxInFlight atomic.Int64
		reachedFour = make(chan struct{})
		reachOnce   sync.Once

		mu     sync.Mutex
		stored = map[int][]byte{}
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" {
			t.Errorf("unexpected storage request method=%s auth=%q", r.Method, r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		cur := inFlight.Add(1)
		defer inFlight.Add(-1)
		for old := maxInFlight.Load(); cur > old; old = maxInFlight.Load() {
			if maxInFlight.CompareAndSwap(old, cur) {
				break
			}
		}
		if cur >= multipartUploadConcurrency {
			reachOnce.Do(func() { close(reachedFour) })
		}
		select {
		case <-reachedFour:
		case <-r.Context().Done():
			return
		case <-time.After(3 * time.Second):
			t.Errorf("timed out waiting for %d concurrent uploads (max=%d)", multipartUploadConcurrency, maxInFlight.Load())
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		n, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
		if err != nil {
			t.Errorf("invalid part path %q: %v", r.URL.Path, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read part %d body: %v", n, err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		mu.Lock()
		stored[n] = body
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer storage.Close()

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/media/uploads/complete" {
			t.Errorf("unexpected gateway path %s", r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(UploadedMedia{
			URL:    storage.URL + "/assembled.mp4",
			Kind:   "video",
			Mime:   "video/mp4",
			Bytes:  int64(len(data)),
			SHA256: hexDigest,
		})
	}))
	defer gateway.Close()

	var (
		events       []recordedProgressEvent
		observations []UploadObservation
	)

	plan := &UploadPlan{PartBytes: partSize}
	for n := 1; n <= partCount; n++ {
		plan.Parts = append(plan.Parts, UploadPart{
			Number:          n,
			Bytes:           partSize,
			UploadURL:       fmt.Sprintf("%s/part/%d", storage.URL, n),
			RequiredHeaders: map[string]string{"Authorization": "must-drop", "X-Api-Key": "must-drop"},
		})
	}

	client := &MediaClient{
		BaseURL:       gateway.URL,
		APIKey:        "fixture",
		AllowHTTPTest: true,
		Progress: func(label string, loaded, total int64, phase string) {
			// Serialized by uploadMultipartParts (no mutex needed here under -race).
			events = append(events, recordedProgressEvent{loaded: loaded, total: total, phase: phase})
		},
		StorageObserve: func(obs UploadObservation) {
			// Serialized by uploadMultipartParts (no mutex needed here under -race).
			observations = append(observations, obs)
		},
	}

	uploaded, err := client.CompleteUploadSource(context.Background(), UploadSession{Ticket: "ticket-concurrent", Multipart: plan}, bytes.NewReader(data), int64(len(data)), "源视频")
	if err != nil {
		t.Fatalf("CompleteUploadSource failed: %v", err)
	}
	if uploaded.URL != storage.URL+"/assembled.mp4" {
		t.Fatalf("uploaded=%+v", uploaded)
	}
	if got := maxInFlight.Load(); got != multipartUploadConcurrency {
		t.Fatalf("max in-flight PUTs = %d, want %d", got, multipartUploadConcurrency)
	}
	if len(observations) != partCount {
		t.Fatalf("StorageObserve count = %d, want %d", len(observations), partCount)
	}
	var assembled []byte
	for n := 1; n <= partCount; n++ {
		assembled = append(assembled, stored[n]...)
	}
	if !bytes.Equal(assembled, data) {
		t.Fatalf("assembled bytes mismatch (len=%d want=%d)", len(assembled), len(data))
	}
	assertMonotonicWithinAttempts(t, events, int64(len(data)))
	if events[0].phase != "resuming" || events[0].loaded != 0 {
		t.Fatalf("first event = %+v, want resuming at 0", events[0])
	}
	last := events[len(events)-1]
	if last.phase != "processing" || last.loaded != int64(len(data)) {
		t.Fatalf("last event = %+v, want processing at %d", last, len(data))
	}
}

func TestMultipartUploadPartialFailureCancelsPeersAndResumesWithoutZeroFlash(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 6
		partSize  = 64 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)
	digest := sha256.Sum256(data)
	hexDigest := hex.EncodeToString(digest[:])

	var (
		mu            sync.Mutex
		puts          = map[int]int{}
		stored        = map[int][]byte{}
		resumes       int
		completes     int
		aborts        int
		peerCanceled  atomic.Bool
		part1Done     = make(chan struct{})
		part3Done     = make(chan struct{})
		part4InFlight = make(chan struct{})
		part1Once     sync.Once
		part3Once     sync.Once
		part4Once     sync.Once
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
		mu.Lock()
		puts[n]++
		attempt := puts[n]
		mu.Unlock()

		// Drain the small request body first so Go's HTTP/1.1 server enters backgroundRead
		// and promptly delivers client disconnect to r.Context().
		if n == 4 && attempt == 1 {
			_, _ = io.Copy(io.Discard, r.Body)
			part4Once.Do(func() { close(part4InFlight) })
			select {
			case <-r.Context().Done():
				peerCanceled.Store(true)
			case <-time.After(3 * time.Second):
				t.Error("expected part 4 to be canceled when part 2 failed")
			}
			return
		}

		// Wait until parts 1 & 3 are stored and part 4 is in-flight, then fail part 2 with retryable 500.
		if n == 2 && attempt == 1 {
			for _, ch := range []chan struct{}{part1Done, part3Done, part4InFlight} {
				select {
				case <-ch:
				case <-time.After(3 * time.Second):
					t.Error("timed out coordinating attempt 1 failure")
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
			}
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `<Error><Code>InternalError</Code><RequestId>cos-500</RequestId></Error>`)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil || int64(len(body)) != partSize {
			return
		}
		mu.Lock()
		stored[n] = body
		mu.Unlock()
		if n == 1 {
			part1Once.Do(func() { close(part1Done) })
		}
		if n == 3 {
			part3Once.Do(func() { close(part3Done) })
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer storage.Close()

	makePlan := func() *UploadPlan {
		mu.Lock()
		defer mu.Unlock()
		plan := &UploadPlan{PartBytes: partSize}
		for n := 1; n <= partCount; n++ {
			plan.Parts = append(plan.Parts, UploadPart{
				Number:    n,
				Bytes:     partSize,
				Received:  len(stored[n]) == partSize,
				UploadURL: fmt.Sprintf("%s/part/%d", storage.URL, n),
			})
		}
		return plan
	}

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		switch r.URL.Path {
		case "/v1/media/uploads/resume":
			resumes++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(UploadSession{Ticket: "ticket-resume", Multipart: makePlan()})
		case "/v1/media/uploads/complete":
			completes++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(UploadedMedia{
				URL:    storage.URL + "/resumed.mp4",
				Kind:   "video",
				Mime:   "video/mp4",
				Bytes:  int64(len(data)),
				SHA256: hexDigest,
			})
		case "/v1/media/uploads/abort":
			aborts++
			mu.Unlock()
			_, _ = io.WriteString(w, `{}`)
		default:
			mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gateway.Close()

	var (
		events       []recordedProgressEvent
		resumeLoaded []int64
		observations []UploadObservation
	)
	client := &MediaClient{
		BaseURL:       gateway.URL,
		APIKey:        "fixture",
		AllowHTTPTest: true,
		Progress: func(_ string, loaded, total int64, phase string) {
			events = append(events, recordedProgressEvent{loaded: loaded, total: total, phase: phase})
			if phase == "resuming" {
				resumeLoaded = append(resumeLoaded, loaded)
			}
		},
		StorageObserve: func(obs UploadObservation) {
			observations = append(observations, obs)
		},
	}

	uploaded, err := client.CompleteUploadSource(context.Background(), UploadSession{Ticket: "ticket-resume", Multipart: makePlan()}, bytes.NewReader(data), int64(len(data)), "源视频")
	if err != nil {
		t.Fatalf("CompleteUploadSource failed: %v", err)
	}
	if uploaded.URL != storage.URL+"/resumed.mp4" {
		t.Fatalf("uploaded=%+v", uploaded)
	}
	if !peerCanceled.Load() {
		t.Fatal("expected in-flight sibling part to be canceled on failure")
	}
	assertMonotonicWithinAttempts(t, events, int64(len(data)))
	for _, obs := range observations {
		if obs.Err != nil && errors.Is(obs.Err, context.Canceled) {
			t.Fatalf("sibling-canceled PUT leaked spurious context.Canceled observation: %+v", obs)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if resumes != 1 || completes != 1 || aborts != 0 {
		t.Fatalf("resumes=%d completes=%d aborts=%d", resumes, completes, aborts)
	}
	if puts[1] != 1 || puts[3] != 1 || puts[2] != 2 || puts[4] != 2 {
		t.Fatalf("unexpected part PUT counts (already received parts must not re-upload): %v", puts)
	}
	if len(resumeLoaded) != 2 || resumeLoaded[0] != 0 || resumeLoaded[1] < 2*partSize {
		t.Fatalf("resume progress events = %v, want [0, >=%d] with no 0 flash on resume", resumeLoaded, 2*partSize)
	}
	var assembled []byte
	for n := 1; n <= partCount; n++ {
		assembled = append(assembled, stored[n]...)
	}
	if !bytes.Equal(assembled, data) {
		t.Fatal("assembled bytes mismatch after resume")
	}
}

func TestMultipartUploadZeroAckRetryResetsToServerAcknowledgedBytes(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 4
		partSize  = 32 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)
	digest := sha256.Sum256(data)
	hexDigest := hex.EncodeToString(digest[:])

	var (
		mu      sync.Mutex
		failed  bool
		stored  = map[int][]byte{}
		resumes int
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return
		}
		mu.Lock()
		shouldFail := !failed
		if shouldFail {
			failed = true
		}
		mu.Unlock()
		if shouldFail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		// Reject any remaining attempt-1 sibling before resume so 0 parts are acked on attempt 1.
		mu.Lock()
		inFirstAttempt := resumes == 0
		if !inFirstAttempt {
			stored[n] = body
		}
		mu.Unlock()
		if inFirstAttempt {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer storage.Close()

	makePlan := func() *UploadPlan {
		mu.Lock()
		defer mu.Unlock()
		plan := &UploadPlan{PartBytes: partSize}
		for n := 1; n <= partCount; n++ {
			plan.Parts = append(plan.Parts, UploadPart{
				Number:    n,
				Bytes:     partSize,
				Received:  len(stored[n]) == partSize,
				UploadURL: fmt.Sprintf("%s/part/%d", storage.URL, n),
			})
		}
		return plan
	}

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/media/uploads/resume":
			mu.Lock()
			resumes++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(UploadSession{Ticket: "ticket-zero-ack", Multipart: makePlan()})
		case "/v1/media/uploads/complete":
			_ = json.NewEncoder(w).Encode(UploadedMedia{
				URL:    storage.URL + "/done.mp4",
				Kind:   "video",
				Mime:   "video/mp4",
				Bytes:  int64(len(data)),
				SHA256: hexDigest,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gateway.Close()

	var events []recordedProgressEvent
	var resumeLoaded []int64
	client := &MediaClient{
		BaseURL:       gateway.URL,
		APIKey:        "fixture",
		AllowHTTPTest: true,
		Progress: func(_ string, loaded, total int64, phase string) {
			events = append(events, recordedProgressEvent{loaded: loaded, total: total, phase: phase})
			if phase == "resuming" {
				resumeLoaded = append(resumeLoaded, loaded)
			}
		},
	}

	if _, err := client.CompleteUploadSource(context.Background(), UploadSession{Ticket: "ticket-zero-ack", Multipart: makePlan()}, bytes.NewReader(data), int64(len(data)), "源视频"); err != nil {
		t.Fatalf("CompleteUploadSource failed: %v", err)
	}
	assertMonotonicWithinAttempts(t, events, int64(len(data)))
	if len(resumeLoaded) != 2 || resumeLoaded[0] != 0 || resumeLoaded[1] != 0 {
		t.Fatalf("zero-ack retry must anchor at server-acknowledged 0 bytes, got resumeLoaded=%v", resumeLoaded)
	}
	last := events[len(events)-1]
	if last.phase != "processing" || last.loaded != int64(len(data)) {
		t.Fatalf("last event = %+v", last)
	}
}

func TestMultipartUploadStorage403RefreshesAndResumes(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 6
		partSize  = 32 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)
	digest := sha256.Sum256(data)
	hexDigest := hex.EncodeToString(digest[:])

	var (
		mu            sync.Mutex
		puts          = map[int]int{}
		stored        = map[int][]byte{}
		freshSigs     = map[int]bool{}
		resumes       int
		completes     int
		aborts        int
		part1Done     = make(chan struct{})
		part3Done     = make(chan struct{})
		part4InFlight = make(chan struct{})
		part1Once     sync.Once
		part3Once     sync.Once
		part4Once     sync.Once
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
		sig := r.URL.Query().Get("sig")
		mu.Lock()
		puts[n]++
		attempt := puts[n]
		afterResume := resumes > 0
		if sig == "fresh" {
			freshSigs[n] = true
		}
		mu.Unlock()

		if afterResume && sig != "fresh" {
			t.Errorf("part %d retried with non-fresh signature %q", n, sig)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if n == 4 && sig == "stale" && attempt == 1 {
			_, _ = io.Copy(io.Discard, r.Body)
			part4Once.Do(func() { close(part4InFlight) })
			select {
			case <-r.Context().Done():
			case <-time.After(3 * time.Second):
				t.Error("part 4 not canceled after storage 403")
			}
			return
		}
		if n == 2 && sig == "stale" {
			for _, ch := range []chan struct{}{part1Done, part3Done, part4InFlight} {
				select {
				case <-ch:
				case <-time.After(3 * time.Second):
					t.Error("timed out coordinating 403")
					return
				}
			}
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `<Error><Code>AccessDenied</Code><RequestId>cos-403</RequestId></Error>`)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || int64(len(body)) != partSize {
			return
		}
		mu.Lock()
		stored[n] = body
		mu.Unlock()
		if n == 1 {
			part1Once.Do(func() { close(part1Done) })
		}
		if n == 3 {
			part3Once.Do(func() { close(part3Done) })
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer storage.Close()

	makePlan := func(sig string) *UploadPlan {
		mu.Lock()
		defer mu.Unlock()
		plan := &UploadPlan{PartBytes: partSize}
		for n := 1; n <= partCount; n++ {
			plan.Parts = append(plan.Parts, UploadPart{
				Number:    n,
				Bytes:     partSize,
				Received:  len(stored[n]) == partSize,
				UploadURL: fmt.Sprintf("%s/part/%d?sig=%s", storage.URL, n, sig),
			})
		}
		return plan
	}

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		switch r.URL.Path {
		case "/v1/media/uploads/resume":
			resumes++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(UploadSession{Ticket: "ticket-403", Multipart: makePlan("fresh")})
		case "/v1/media/uploads/complete":
			completes++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(UploadedMedia{
				URL:    storage.URL + "/refreshed.mp4",
				Kind:   "video",
				Mime:   "video/mp4",
				Bytes:  int64(len(data)),
				SHA256: hexDigest,
			})
		case "/v1/media/uploads/abort":
			aborts++
			mu.Unlock()
			_, _ = io.WriteString(w, `{}`)
		default:
			mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gateway.Close()

	client := &MediaClient{BaseURL: gateway.URL, APIKey: "fixture", AllowHTTPTest: true}
	uploaded, err := client.CompleteUploadSource(context.Background(), UploadSession{Ticket: "ticket-403", Multipart: makePlan("stale")}, bytes.NewReader(data), int64(len(data)), "源视频")
	if err != nil {
		t.Fatalf("storage 403 refresh failed: %v", err)
	}
	if uploaded.URL != storage.URL+"/refreshed.mp4" {
		t.Fatalf("uploaded=%+v", uploaded)
	}
	mu.Lock()
	defer mu.Unlock()
	if resumes != 1 || completes != 1 || aborts != 0 || puts[1] != 1 || puts[3] != 1 {
		t.Fatalf("resumes=%d completes=%d aborts=%d puts=%v", resumes, completes, aborts, puts)
	}
	for _, n := range []int{2, 4} {
		if !freshSigs[n] {
			t.Fatalf("part %d did not use refreshed presigned URL after resume (freshSigs=%v)", n, freshSigs)
		}
	}
}
