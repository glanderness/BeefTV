package generation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

type videoDownloadPartialContext struct{}

func withVideoDownloadPartial(ctx context.Context) (context.Context, func(), error) {
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.DownloadCache != nil {
		if path := strings.TrimSpace(runtime.DownloadCache.PartialPath()); path != "" {
			return context.WithValue(ctx, videoDownloadPartialContext{}, path), func() {}, nil
		}
	}
	f, err := os.CreateTemp("", "beeftv-video-download-*.part")
	if err != nil {
		return ctx, nil, err
	}
	path := f.Name()
	_ = f.Close()
	_ = os.Remove(path)
	return context.WithValue(ctx, videoDownloadPartialContext{}, path), func() {
		_ = os.Remove(path)
		_ = os.Remove(path + ".json")
	}, nil
}

// executeVideoRequestToFile streams a video result HTTP request directly to a
// file on disk. GET requests without a body use outbound.DownloadResumableToFile
// for Range-resumable transfer; non-GET protocol result requests stream via
// outbound.StreamResponseToFile with the same size cap and idle watchdog.
func executeVideoRequestToFile(req *http.Request) (string, string, error) {
	ctx := req.Context()
	partial, _ := ctx.Value(videoDownloadPartialContext{}).(string)
	if partial == "" {
		var cleanup func()
		var err error
		ctx, cleanup, err = withVideoDownloadPartial(ctx)
		if err != nil {
			return "", "", err
		}
		defer cleanup()
		partial, _ = ctx.Value(videoDownloadPartialContext{}).(string)
		req = req.WithContext(ctx)
	}
	if req.Method == http.MethodGet && req.Body == nil {
		return getResumableVideoFile(req, partial, 0)
	}
	ctx, req, limit, release, err := prepareVideoDownloadSlot(ctx, req, 0)
	if err != nil {
		return "", "", err
	}
	defer release()
	headerTimeout, idleTimeout := videoDownloadTimeouts(ctx)
	reqCtx, stopHeader, reqCancel := outbound.WithHeaderTimeout(ctx, headerTimeout)
	defer reqCancel(nil)
	defer stopHeader()
	resp, err := openVideoDownloadResponse(req.WithContext(reqCtx), limit)
	stopHeader()
	if err != nil {
		if cause := context.Cause(reqCtx); cause != nil && ctx.Err() == nil {
			return "", "", cause
		}
		return "", "", err
	}
	var streamErr error
	if obs, ok := resp.Body.(*videoObservedBody); ok {
		obs.observeOnEnd = true
		defer func() {
			_ = resp.Body.Close()
			obs.observe(streamErr)
		}()
	} else {
		defer resp.Body.Close()
	}
	res, err := outbound.StreamResponseToFile(ctx, resp, outbound.StreamFileOptions{
		Dir:         filepath.Dir(partial),
		MaxBytes:    outbound.ExclusiveByteLimit(limit),
		IdleTimeout: idleTimeout,
		Cancel:      func() { reqCancel(context.DeadlineExceeded) },
	})
	if err != nil {
		streamErr = err
		return "", "", err
	}
	return res.Path, res.MimeType, nil
}

type videoDownloadHeaderTimeoutContext struct{}

func videoDownloadTimeouts(ctx context.Context) (headerTimeout, idleTimeout time.Duration) {
	headerTimeout = 45 * time.Second
	if customHeader, _ := ctx.Value(videoDownloadHeaderTimeoutContext{}).(time.Duration); customHeader > 0 {
		headerTimeout = customHeader
	}
	idleTimeout = videoDeliveryIdleTimeout
	if customIdle, _ := ctx.Value(videoDeliveryRequestContext{}).(time.Duration); customIdle > 0 {
		idleTimeout = customIdle
	}
	return headerTimeout, idleTimeout
}

func prepareVideoDownloadSlot(ctx context.Context, req *http.Request, maxCap int64) (context.Context, *http.Request, int64, func(), error) {
	limit := MaxResponseBytes
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.Limits != nil {
		var err error
		limit, err = runtime.Limits.GeneratedFileBytes(ctx)
		if err != nil {
			return ctx, req, 0, nil, err
		}
	}
	if maxCap > 0 && limit > maxCap {
		limit = maxCap
	}
	if limit <= 0 {
		return ctx, req, 0, nil, outbound.ErrResourceTooLarge
	}
	release := func() {}
	if runtime.Limits != nil {
		slot := runtime.Call.ChannelID
		if slot == "" {
			slot = "custom:" + strings.ToLower(req.URL.Host)
		}
		var concurrencyLimit int
		var err error
		release, concurrencyLimit, err = runtime.Limits.AcquireChannelSlot(ctx, runtime.Call.ChannelID, slot, time.Until(PollingDeadline(ctx))+time.Minute)
		if err != nil {
			return ctx, req, 0, nil, err
		}
		runtime.Call.ConcurrencyLimit = concurrencyLimit
		ctx = WithRuntime(ctx, runtime)
		req = req.WithContext(ctx)
	}
	return ctx, req, limit, release, nil
}

func getResumableVideoFile(req *http.Request, partial string, maxCap int64) (string, string, error) {
	ctx, req, limit, release, err := prepareVideoDownloadSlot(req.Context(), req, maxCap)
	if err != nil {
		return "", "", err
	}
	defer release()
	headers := req.Header.Clone()
	headers.Del("Range")
	headers.Del("If-Range")
	headerTimeout, idleTimeout := videoDownloadTimeouts(ctx)
	total := int64(-1)
	result, err := outbound.DownloadResumableToFile(ctx, req.URL.String(), outbound.ResumableOptions{
		PartialPath: partial, Headers: headers, MaxBytes: outbound.ExclusiveByteLimit(limit),
		Attempts: 1, HeaderTimeout: headerTimeout, IdleTimeout: idleTimeout,
		OpenResponse: func(request *http.Request) (*http.Response, error) { return openVideoDownloadResponse(request, limit) },
		OnProgress: func(update outbound.ResumableProgress) {
			total = update.TotalBytes
			if observe := downloadObserverFrom(ctx); observe != nil {
				observe(update.DownloadedBytes, update.TotalBytes)
			}
		},
	})
	// The shared downloader throttles body progress. Report the final retained
	// count here too, including a short read that ended inside that interval.
	if observe := downloadObserverFrom(ctx); observe != nil {
		downloaded := result.Size
		if err != nil {
			if info, statErr := os.Stat(partial); statErr == nil {
				downloaded = info.Size()
			}
		}
		observe(downloaded, total)
	}
	// The resumable transport's own header/idle timer cancels an attempt without
	// canceling the owning task. The existing video loop owns the next attempt.
	if errors.Is(err, context.Canceled) && ctx.Err() == nil {
		err = context.DeadlineExceeded
	}
	return result.Path, result.MimeType, err
}

// Preserve the generation transport's credentials policy while keeping range
// headers across the gateway's cross-origin redirect to a signed media URL.
func videoDownloadHTTPClient(req *http.Request, timeout time.Duration) *http.Client {
	client := outbound.OutboundHTTPClient(timeout)
	checkRedirect := client.CheckRedirect
	credentials, _ := req.Context().Value(videoCredentialContext{}).(videoProviderCredentials)
	leftOrigin := false
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if err := checkRedirect(next, via); err != nil {
			return err
		}
		if !SameProviderOrigin(req.URL.String(), next.URL.String()) {
			leftOrigin = true
		}
		if leftOrigin {
			rangeValue, validator := next.Header.Get("Range"), next.Header.Get("If-Range")
			next.Header = make(http.Header)
			outbound.ApplyDefaultOutboundHeaders(next)
			if rangeValue != "" {
				next.Header.Set("Range", rangeValue)
			}
			if validator != "" {
				next.Header.Set("If-Range", validator)
			}
			stripVideoCredentialQuery(next.URL, credentials.Values)
		}
		return nil
	}
	if noRedirect, _ := req.Context().Value(binaryNoRedirectContext{}).(bool); noRedirect {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	return client
}

func openVideoDownloadResponse(req *http.Request, limit int64) (*http.Response, error) {
	credentials, _ := req.Context().Value(videoCredentialContext{}).(videoProviderCredentials)
	if !SameProviderOrigin(credentials.Origin, req.URL.String()) {
		stripVideoCredentialQuery(req.URL, credentials.Values)
	}
	runtime, _ := RuntimeFromContext(req.Context())
	observation := TransportObservation{Request: req, StartedAt: time.Now(), ResponseLimitBytes: limit}
	trace := &transportTrace{}
	req = trace.attach(req)
	if _, err := outbound.ValidateOutboundURLContext(req.Context(), req.URL.String()); err != nil {
		observation.Dispatched, observation.TransportPhase = trace.result(err)
		observation.Err = err
		if runtime.Receipts != nil {
			runtime.Receipts.Observe(observation)
		}
		return nil, err
	}
	response, err := videoDownloadHTTPClient(req, 0).Do(req)
	observation.Dispatched, observation.TransportPhase = trace.result(err)
	if err != nil {
		observation.Err = err
		if runtime.Receipts != nil {
			runtime.Receipts.Observe(observation)
		}
		return nil, err
	}
	observation.StatusCode, observation.HTTPStatus = response.StatusCode, response.StatusCode
	observation.DeclaredResponseBytes = response.ContentLength
	observation.RequestID = firstNonEmpty(response.Header.Get("X-Request-Id"), response.Header.Get("Request-Id"))
	observation.TransportRoute = outbound.RequestNetworkRoute(response.Request, outbound.OutboundHTTPClient(0).Transport)
	body := &videoObservedBody{ReadCloser: response.Body, observation: observation, receipts: runtime.Receipts}
	response.Body = body
	if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		raw, _ := io.ReadAll(io.LimitReader(body, 64<<10))
		var resultErr error = HTTPError{StatusCode: response.StatusCode, Status: response.Status, Body: string(raw), RequestID: observation.RequestID, RetryAfter: ParseRetryAfter(response.Header.Get("Retry-After"), time.Now())}
		if !SameProviderOrigin(req.URL.String(), response.Request.URL.String()) && (response.StatusCode == 401 || response.StatusCode == 403) {
			resultErr = videoBackupLinkExpiredError{cause: resultErr}
		}
		// OpenResponse returns before the shared downloader can classify HTTP
		// errors. A rejected Range must not pin every later attempt to the same
		// invalid offset. Keep bytes for authentication and temporary failures.
		retry, _ := RetryableVideoPollError(context.WithoutCancel(req.Context()), resultErr)
		if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden && !retry {
			if partial, _ := req.Context().Value(videoDownloadPartialContext{}).(string); partial != "" {
				_ = os.Remove(partial)
				_ = os.Remove(partial + ".json")
			}
			if response.StatusCode == http.StatusBadRequest && req.Header.Get("Range") != "" {
				resultErr = fmt.Errorf("%w: %w", outbound.ErrResumeRestart, resultErr)
			}
		}
		body.setErr(resultErr)
		_ = body.Close()
		return nil, resultErr
	}
	return response, nil
}

type videoObservedBody struct {
	io.ReadCloser
	mu           sync.Mutex
	observation  TransportObservation
	receipts     ReceiptPort
	observeOnEnd bool
	observeOnce  sync.Once
}

func (b *videoObservedBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	b.mu.Lock()
	b.observation.ReceivedBytes += int64(n)
	if err != nil && !errors.Is(err, io.EOF) {
		b.observation.Err = err
	}
	b.mu.Unlock()
	return n, err
}

func (b *videoObservedBody) setErr(err error) {
	b.mu.Lock()
	b.observation.Err = err
	b.mu.Unlock()
}

func (b *videoObservedBody) observe(finalErr error) {
	b.observeOnce.Do(func() {
		if b.receipts == nil {
			return
		}
		b.mu.Lock()
		if b.observation.Err == nil && finalErr != nil {
			b.observation.Err = finalErr
		}
		obs := b.observation
		b.mu.Unlock()
		b.receipts.Observe(obs)
	})
}

func (b *videoObservedBody) Close() error {
	err := b.ReadCloser.Close()
	if !b.observeOnEnd {
		b.observe(nil)
	}
	return err
}
