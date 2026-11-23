package beeftv

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/outbound"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const multipartUploadConcurrency = 4

type uploadProgressReader struct {
	io.Reader
	onDelta func(int64)
}

func (r *uploadProgressReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n > 0 && r.onDelta != nil {
		r.onDelta(int64(n))
	}
	return n, err
}

func (c *MediaClient) putStorage(ctx context.Context, link string, headers map[string]string, source io.Reader, size, offset, total int64, label string) error {
	loaded := offset
	var onDelta func(int64)
	if c.Progress != nil {
		onDelta = func(delta int64) {
			loaded += delta
			c.Progress(label, loaded, total, "transferring")
		}
	}
	return c.putStorageWithCallbacks(ctx, link, headers, source, size, onDelta, c.StorageObserve)
}

func (c *MediaClient) putStorageWithCallbacks(ctx context.Context, link string, headers map[string]string, source io.Reader, size int64, onDelta func(int64), onObserve func(UploadObservation)) (resultErr error) {
	ctx = c.networkContext(ctx)
	meta := UploadMetaFromContext(ctx)
	if meta.Attempt == 0 {
		meta.Attempt = 1
	}
	ctx = withUploadMeta(ctx, "put", meta.Attempt)
	body := &uploadProgressReader{Reader: source, onDelta: onDelta}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, link, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.GetBody = nil
	for key, value := range headers {
		if !skipStorageHeader(key) {
			req.Header.Set(key, value)
		}
	}
	client := *c.httpClient()
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	trace := &outbound.TransportTrace{}
	req = trace.Attach(req)
	observation := UploadObservation{Request: req, StartedAt: time.Now(), Route: "direct"}
	validating := true
	if route := outbound.RequestNetworkRoute(req, client.Transport); route != "" {
		observation.Route = route
	}
	defer func() {
		observation.Dispatched, observation.Phase = trace.Result(resultErr)
		if validating {
			observation.Dispatched = false
			observation.Phase = "dns"
		}
		if resultErr != nil {
			resultErr = &UploadError{Meta: UploadMetaFromContext(ctx), Dispatched: observation.Dispatched, Phase: observation.Phase, Cause: resultErr}
		}
		observation.Err = resultErr
		if onObserve != nil {
			onObserve(observation)
		}
	}()
	if err := c.validURLContext(req.Context(), link); err != nil {
		return err
	}
	validating = false
	resp, err := client.Do(req)
	observation.Response = resp
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	errorBody, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	observation.ReceivedBytes = int64(len(errorBody))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			return ErrUploadRedirect
		}
		var failure struct {
			Code      string `xml:"Code"`
			RequestID string `xml:"RequestId"`
		}
		_ = xml.Unmarshal(errorBody, &failure)
		if failure.RequestID == "" {
			failure.RequestID = resp.Header.Get("X-Amz-Request-Id")
		}
		if failure.RequestID == "" {
			failure.RequestID = resp.Header.Get("X-Cos-Request-Id")
		}
		if failure.Code == "" {
			failure.Code = "storage_put_failed"
		}
		return &MediaHTTPError{StatusCode: resp.StatusCode, TaskError: MediaTaskError{Code: failure.Code, Message: fmt.Sprintf("素材直传未完成（HTTP %d）", resp.StatusCode)}, RequestID: failure.RequestID}
	}
	if readErr != nil {
		return readErr
	}
	return nil
}

type multipartUploadJob struct {
	part   UploadPart
	offset int64
}

func isStorageForbiddenError(err error) bool {
	var storageFailure *MediaHTTPError
	return errors.As(err, &storageFailure) && storageFailure.StatusCode == http.StatusForbidden
}

func isResumableMultipartPutError(err error) bool {
	return retryUploadControl(err) || isStorageForbiddenError(err)
}

// selectMultipartPutError chooses a deterministic failure across concurrent part
// workers so a retryable 5xx/network error cannot mask a definitive non-retryable 4xx,
// and derived context.Canceled errors never mask parent deadlines or real HTTP failures.
func selectMultipartPutError(ctx context.Context, errs []error) error {
	var fatalErr, forbiddenErr, retryableErr, canceledErr error
	for _, err := range errs {
		if err == nil {
			continue
		}
		if errors.Is(err, context.Canceled) {
			if canceledErr == nil {
				canceledErr = err
			}
			continue
		}
		switch {
		case !isResumableMultipartPutError(err):
			if fatalErr == nil {
				fatalErr = err
			}
		case isStorageForbiddenError(err):
			if forbiddenErr == nil {
				forbiddenErr = err
			}
		default:
			if retryableErr == nil {
				retryableErr = err
			}
		}
	}
	switch {
	case fatalErr != nil:
		return fatalErr
	case forbiddenErr != nil:
		return forbiddenErr
	case retryableErr != nil:
		return retryableErr
	case ctx.Err() != nil:
		return uploadError(ctx, ctx.Err())
	default:
		return canceledErr
	}
}

// uploadMultipartParts uploads unreceived parts with fixed bounded concurrency.
// Progress policy: each attempt emits one "resuming" anchor at server-acknowledged
// bytes (never flashing 0 when acknowledged parts exist, and honestly rolling back
// unconfirmed speculative bytes on retry to match referenceReporter.resumeAt),
// then advances strictly monotonically within the attempt.
func (c *MediaClient) uploadMultipartParts(ctx context.Context, parts []UploadPart, source io.ReaderAt, size int64, label string) error {
	if err := ctx.Err(); err != nil {
		return uploadError(ctx, err)
	}
	var offset, received int64
	pending := make([]multipartUploadJob, 0, len(parts))
	for _, part := range parts {
		if part.Received {
			received += part.Bytes
		} else {
			pending = append(pending, multipartUploadJob{part: part, offset: offset})
		}
		offset += part.Bytes
	}
	received = min(received, size)
	if c.Progress != nil {
		c.Progress(label, received, size, "resuming")
	}
	if len(pending) == 0 {
		return nil
	}

	workers := min(multipartUploadConcurrency, len(pending))
	partCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		next       atomic.Int64
		progressMu sync.Mutex
		observeMu  sync.Mutex
		errMu      sync.Mutex
		workerErrs []error
		wg         sync.WaitGroup
	)
	var onDelta func(int64)
	if c.Progress != nil {
		uploaded := received
		onDelta = func(delta int64) {
			progressMu.Lock()
			nextLoaded := min(uploaded+delta, size)
			if nextLoaded > uploaded {
				uploaded = nextLoaded
				c.Progress(label, uploaded, size, "transferring")
			}
			progressMu.Unlock()
		}
	}
	onObserve := func(observation UploadObservation) {
		// Cancel sibling PUTs immediately when any worker observes an error,
		// before potentially slow StorageObserve I/O runs.
		if observation.Err != nil {
			cancel()
		}
		if c.StorageObserve == nil {
			return
		}
		// Suppress internal sibling cancellations so one failed part does not
		// log spurious task-cancellation receipts when parent ctx is still active.
		if observation.Err != nil && ctx.Err() == nil && errors.Is(observation.Err, context.Canceled) {
			return
		}
		observeMu.Lock()
		c.StorageObserve(observation)
		observeMu.Unlock()
	}

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if partCtx.Err() != nil {
					return
				}
				index := int(next.Add(1) - 1)
				if index >= len(pending) {
					return
				}
				job := pending[index]
				err := c.putStorageWithCallbacks(
					partCtx,
					job.part.UploadURL,
					job.part.RequiredHeaders,
					io.NewSectionReader(source, job.offset, job.part.Bytes),
					job.part.Bytes,
					onDelta,
					onObserve,
				)
				if err != nil {
					errMu.Lock()
					workerErrs = append(workerErrs, err)
					errMu.Unlock()
					cancel()
					return
				}
			}
		}()
	}
	wg.Wait()
	return selectMultipartPutError(ctx, workerErrs)
}
