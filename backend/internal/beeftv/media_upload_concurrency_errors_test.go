package beeftv

import (
	"bytes"
	"context"
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

func TestSelectMultipartPutErrorPriority(t *testing.T) {
	err400 := &UploadError{Cause: &MediaHTTPError{StatusCode: http.StatusBadRequest, RequestID: "cos-400"}}
	err403 := &UploadError{Cause: &MediaHTTPError{StatusCode: http.StatusForbidden, RequestID: "cos-403"}}
	err500 := &UploadError{Cause: &MediaHTTPError{StatusCode: http.StatusInternalServerError, RequestID: "cos-500"}}
	errCanceled := &UploadError{Cause: context.Canceled}

	deadlineCtx, cancelDeadline := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelDeadline()
	canceledCtx, cancelParent := context.WithCancel(context.Background())
	cancelParent()

	cases := []struct {
		name string
		ctx  context.Context
		errs []error
		want func(error) bool
	}{
		{
			name: "fatal 400 beats retryable 500 regardless of order",
			ctx:  context.Background(),
			errs: []error{err500, errCanceled, err400},
			want: func(err error) bool {
				var h *MediaHTTPError
				return errors.As(err, &h) && h.StatusCode == http.StatusBadRequest && h.RequestID == "cos-400"
			},
		},
		{
			name: "storage 403 beats retryable 500 and sibling cancel",
			ctx:  context.Background(),
			errs: []error{errCanceled, err500, err403},
			want: func(err error) bool {
				var h *MediaHTTPError
				return errors.As(err, &h) && h.StatusCode == http.StatusForbidden && h.RequestID == "cos-403"
			},
		},
		{
			name: "parent DeadlineExceeded is not masked by sibling context.Canceled",
			ctx:  deadlineCtx,
			errs: []error{errCanceled, errCanceled},
			want: func(err error) bool { return errors.Is(err, context.DeadlineExceeded) },
		},
		{
			name: "real 400 still beats sibling cancel even after parent deadline expires",
			ctx:  deadlineCtx,
			errs: []error{errCanceled, err400},
			want: func(err error) bool {
				var h *MediaHTTPError
				return errors.As(err, &h) && h.StatusCode == http.StatusBadRequest
			},
		},
		{
			name: "retryable 500 beats sibling cancel under expired parent so outer loop observes deadline",
			ctx:  deadlineCtx,
			errs: []error{errCanceled, err500},
			want: func(err error) bool {
				var h *MediaHTTPError
				return errors.As(err, &h) && h.StatusCode == http.StatusInternalServerError && h.RequestID == "cos-500"
			},
		},
		{
			name: "active parent with only context.Canceled falls back to canceled error instead of nil",
			ctx:  context.Background(),
			errs: []error{errCanceled},
			want: func(err error) bool { return errors.Is(err, context.Canceled) },
		},
		{
			name: "parent Canceled returns context.Canceled",
			ctx:  canceledCtx,
			errs: []error{errCanceled},
			want: func(err error) bool { return errors.Is(err, context.Canceled) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := selectMultipartPutError(tc.ctx, tc.errs)
			if !tc.want(got) {
				t.Fatalf("selectMultipartPutError() = %T (%v)", got, got)
			}
		})
	}
}

func TestMultipartUploadCancelsPeersBeforeSlowStorageObserve(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 4
		partSize  = 32 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)

	var (
		peersInFlight  atomic.Int64
		peersCanceled  atomic.Int64
		allPeersReady  = make(chan struct{})
		allPeersBroken = make(chan struct{})
		readyOnce      sync.Once
		brokenOnce     sync.Once
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
		_, _ = io.Copy(io.Discard, r.Body)
		if n == 1 {
			select {
			case <-allPeersReady:
			case <-time.After(3 * time.Second):
				t.Error("timed out waiting for peer PUTs")
				return
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `<Error><Code>InvalidPart</Code><RequestId>cos-400</RequestId></Error>`)
			return
		}
		if peersInFlight.Add(1) >= multipartUploadConcurrency-1 {
			readyOnce.Do(func() { close(allPeersReady) })
		}
		select {
		case <-r.Context().Done():
			if peersCanceled.Add(1) >= multipartUploadConcurrency-1 {
				brokenOnce.Do(func() { close(allPeersBroken) })
			}
		case <-time.After(3 * time.Second):
			t.Errorf("peer part %d was not canceled before StorageObserve returned", n)
		}
	}))
	defer storage.Close()

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer gateway.Close()

	plan := &UploadPlan{PartBytes: partSize}
	for n := 1; n <= partCount; n++ {
		plan.Parts = append(plan.Parts, UploadPart{
			Number:    n,
			Bytes:     partSize,
			UploadURL: fmt.Sprintf("%s/part/%d", storage.URL, n),
		})
	}
	client := &MediaClient{
		BaseURL:       gateway.URL,
		APIKey:        "fixture",
		AllowHTTPTest: true,
		StorageObserve: func(obs UploadObservation) {
			if obs.Err != nil {
				// Block until all 3 peer server handlers observe cancellation:
				// proves cancel() fired BEFORE slow StorageObserve I/O ran.
				select {
				case <-allPeersBroken:
				case <-time.After(3 * time.Second):
					t.Error("peers remained uncanceled while StorageObserve blocked")
				}
			}
		},
	}

	_, err := client.CompleteUploadSource(context.Background(), UploadSession{Ticket: "ticket-observe-order", Multipart: plan}, bytes.NewReader(data), int64(len(data)), "源视频")
	var httpErr *MediaHTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusBadRequest {
		t.Fatalf("want HTTP 400, got %v", err)
	}
}

func TestMultipartUploadParentDeadlinePreservesDeadlineExceeded(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 4
		partSize  = 32 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	}))
	defer storage.Close()

	var aborts atomic.Int64
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/media/uploads/abort" {
			aborts.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer gateway.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()

	plan := &UploadPlan{PartBytes: partSize}
	for n := 1; n <= partCount; n++ {
		plan.Parts = append(plan.Parts, UploadPart{
			Number:    n,
			Bytes:     partSize,
			UploadURL: fmt.Sprintf("%s/part/%d", storage.URL, n),
		})
	}
	client := &MediaClient{BaseURL: gateway.URL, APIKey: "fixture", AllowHTTPTest: true}
	_, err := client.CompleteUploadSource(ctx, UploadSession{Ticket: "ticket-deadline", Multipart: plan}, bytes.NewReader(data), int64(len(data)), "源视频")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want context.DeadlineExceeded, got %v", err)
	}
	if aborts.Load() != 1 {
		t.Fatalf("aborts = %d, want 1", aborts.Load())
	}
}

func TestMultipartUploadNonRetryableErrorFailsFastAndAborts(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 6
		partSize  = 32 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)

	var (
		resumes   atomic.Int64
		aborts    atomic.Int64
		completes atomic.Int64
		peerSeen  = make(chan struct{})
		peerOnce  sync.Once
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
		if n == 1 {
			select {
			case <-peerSeen:
			case <-time.After(2 * time.Second):
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `<Error><Code>InvalidPart</Code><RequestId>cos-400</RequestId></Error>`)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		peerOnce.Do(func() { close(peerSeen) })
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
			t.Errorf("part %d was not canceled after non-retryable 400", n)
		}
	}))
	defer storage.Close()

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/media/uploads/resume":
			resumes.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		case "/v1/media/uploads/complete":
			completes.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		case "/v1/media/uploads/abort":
			aborts.Add(1)
			_, _ = io.WriteString(w, `{}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gateway.Close()

	plan := &UploadPlan{PartBytes: partSize}
	for n := 1; n <= partCount; n++ {
		plan.Parts = append(plan.Parts, UploadPart{
			Number:    n,
			Bytes:     partSize,
			UploadURL: fmt.Sprintf("%s/part/%d", storage.URL, n),
		})
	}
	client := &MediaClient{BaseURL: gateway.URL, APIKey: "fixture", AllowHTTPTest: true}
	_, err := client.CompleteUploadSource(context.Background(), UploadSession{Ticket: "ticket-400", Multipart: plan}, bytes.NewReader(data), int64(len(data)), "源视频")
	if err == nil {
		t.Fatal("expected HTTP 400 error")
	}
	var httpErr *MediaHTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusBadRequest || httpErr.RequestID != "cos-400" {
		t.Fatalf("want real MediaHTTPError(400, cos-400), got %T: %v", err, err)
	}
	if resumes.Load() != 0 || completes.Load() != 0 || aborts.Load() != 1 {
		t.Fatalf("resumes=%d completes=%d aborts=%d", resumes.Load(), completes.Load(), aborts.Load())
	}
}

func TestMultipartUploadMidFlightParentCancelAbortsPromptly(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	const (
		partCount = 6
		partSize  = 32 << 10
	)
	data := makeMultipartFixtureBytes(partCount, partSize)

	var (
		inFlight        atomic.Int64
		canceledCount   atomic.Int64
		aborts          atomic.Int64
		resumes         atomic.Int64
		allFourInFlight = make(chan struct{})
		fourOnce        sync.Once
	)

	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if inFlight.Add(1) >= multipartUploadConcurrency {
			fourOnce.Do(func() { close(allFourInFlight) })
		}
		select {
		case <-r.Context().Done():
			canceledCount.Add(1)
		case <-time.After(3 * time.Second):
			t.Error("handler did not observe mid-flight parent cancellation")
		}
	}))
	defer storage.Close()

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/media/uploads/abort":
			aborts.Add(1)
			_, _ = io.WriteString(w, `{}`)
		case "/v1/media/uploads/resume":
			resumes.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gateway.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-allFourInFlight
		cancel()
	}()

	var observedCancels int
	plan := &UploadPlan{PartBytes: partSize}
	for n := 1; n <= partCount; n++ {
		plan.Parts = append(plan.Parts, UploadPart{
			Number:    n,
			Bytes:     partSize,
			UploadURL: fmt.Sprintf("%s/part/%d", storage.URL, n),
		})
	}
	client := &MediaClient{
		BaseURL:       gateway.URL,
		APIKey:        "fixture",
		AllowHTTPTest: true,
		StorageObserve: func(obs UploadObservation) {
			if obs.Err != nil && errors.Is(obs.Err, context.Canceled) {
				observedCancels++
			}
		},
	}

	_, err := client.CompleteUploadSource(ctx, UploadSession{Ticket: "ticket-cancel", Multipart: plan}, bytes.NewReader(data), int64(len(data)), "源视频")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	if aborts.Load() != 1 || resumes.Load() != 0 {
		t.Fatalf("aborts=%d resumes=%d", aborts.Load(), resumes.Load())
	}
	if observedCancels == 0 {
		t.Fatal("real parent cancellation must still be reported to StorageObserve")
	}
	// Close storage before asserting server-side cancellation count so all handlers have finished.
	storage.Close()
	if canceledCount.Load() != multipartUploadConcurrency {
		t.Fatalf("server observed %d canceled PUTs, want %d", canceledCount.Load(), multipartUploadConcurrency)
	}
}

func TestUploadMultipartPartsReturnsCancelWhenContextAlreadyCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := &MediaClient{AllowHTTPTest: true}
	parts := []UploadPart{{Number: 1, Bytes: 4, UploadURL: "http://127.0.0.1/part/1"}}
	err := client.uploadMultipartParts(ctx, parts, bytes.NewReader([]byte("test")), 4, "源视频")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}
