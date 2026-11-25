package outbound

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ExclusiveByteLimit converts an inclusive byte cap (e.g. 2048 MiB) into the
// exclusive MaxBytes sentinel expected by DownloadResumableToFile so exact
// at-limit artifacts succeed consistently across all routes.
func ExclusiveByteLimit(limit int64) int64 {
	if limit <= 0 {
		return 0
	}
	if limit == math.MaxInt64 {
		return math.MaxInt64
	}
	return limit + 1
}

// ErrResourceTooLarge marks a download that exceeded the caller's hard byte cap.
// It is non-retryable so the caller can map it to the product size-limit copy.
var ErrResourceTooLarge = errors.New("远程资源超过大小上限")

// ErrResumeRestart means cached bytes no longer match the current response.
var ErrResumeRestart = errors.New("远程资源需要重新完整下载")

// ResumableOptions configures DownloadResumable. There is deliberately no total
// timeout here: the caller owns the overall delivery deadline through ctx.
type ResumableOptions struct {
	PartialPath   string
	Headers       http.Header
	MaxBytes      int64
	HeaderTimeout time.Duration
	IdleTimeout   time.Duration
	Attempts      int
	// OpenResponse lets authenticated callers retain their redirect and
	// diagnostic policy. Range and If-Range are already set.
	OpenResponse func(*http.Request) (*http.Response, error)
	// OnProgress reports transfer progress. It is called synchronously from the
	// download goroutine, never after DownloadResumable returns, and is throttled
	// to resumableProgressInterval between body reads.
	OnProgress func(ResumableProgress)
}

// ResumableProgress is a point-in-time snapshot of a resumable download.
type ResumableProgress struct {
	DownloadedBytes int64  // includes the resumed offset
	TotalBytes      int64  // -1 when unknown
	BytesPerSecond  int64  // smoothed over roughly the last 3s; 0 when stalled/unknown
	Attempt         int    // 1-based
	State           string // "downloading" | "retrying" | "waiting"
}

// ResumableFileResult describes a completed resumable download kept on disk so
// large artifacts (e.g. 1-2 GiB videos) can be validated, remuxed, and persisted
// without loading the entire file into memory. The caller owns Path and must
// remove it when done.
type ResumableFileResult struct {
	Path     string
	Size     int64
	MimeType string
	FileName string
}

const (
	defaultResumableAttempts      = 4
	defaultResumableHeaderTimeout = 30 * time.Second
	defaultResumableIdleTimeout   = 45 * time.Second
	resumableReadBuffer           = 32 << 10
	resumableProgressInterval     = 500 * time.Millisecond
	resumableRateWindow           = 3 * time.Second
	resumableRateSampleInterval   = 100 * time.Millisecond
)

type resumableSidecar struct {
	URL          string `json:"url"`
	ETag         string `json:"etag"`
	LastModified string `json:"lastModified"`
	Total        int64  `json:"total"`
	MimeType     string `json:"mimeType,omitempty"`
}

// DownloadResumableToFile streams a remote artifact to PartialPath and resumes
// from existing bytes across transient failures. Once complete, PartialPath is
// atomically renamed to a unique owned path in the same directory before the
// per-path lock is released, so large media never enters Go heap memory.
func DownloadResumableToFile(ctx context.Context, rawURL string, opts ResumableOptions) (ResumableFileResult, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ResumableFileResult{}, fmt.Errorf("外部资源地址无效")
	}
	if strings.TrimSpace(opts.PartialPath) == "" {
		return ResumableFileResult{}, errors.New("下载缓存路径未配置")
	}
	if opts.MaxBytes <= 0 {
		return ResumableFileResult{}, errors.New("下载大小上限未配置")
	}
	attempts := opts.Attempts
	if attempts <= 0 {
		attempts = defaultResumableAttempts
	}
	headerTimeout := opts.HeaderTimeout
	if headerTimeout <= 0 {
		headerTimeout = defaultResumableHeaderTimeout
	}
	idleTimeout := opts.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultResumableIdleTimeout
	}
	if err := os.MkdirAll(filepath.Dir(opts.PartialPath), 0o700); err != nil {
		return ResumableFileResult{}, err
	}

	unlock := lockResumableDownload(opts.PartialPath)
	defer unlock()

	var lastErr error
	freshConn := false
	for attempt := 0; attempt < attempts; attempt++ {
		attemptNumber := attempt + 1
		if attempt > 0 {
			reportResumableRetrying(opts, attemptNumber)
			if err := waitResumableBackoff(ctx, attempt); err != nil {
				return ResumableFileResult{}, err
			}
		}
		result, retryable, err := downloadResumableAttempt(ctx, parsed, opts, headerTimeout, idleTimeout, attemptNumber, freshConn)
		if err == nil {
			return result, nil
		}
		if ctx.Err() != nil {
			return ResumableFileResult{}, ctx.Err()
		}
		if !retryable {
			return ResumableFileResult{}, err
		}
		if IsConnectionDrop(err) {
			freshConn = true
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("远程资源下载失败")
	}
	return ResumableFileResult{}, lastErr
}

func reportResumableRetrying(opts ResumableOptions, attemptNumber int) {
	if opts.OnProgress == nil {
		return
	}
	downloaded := int64(0)
	total := int64(-1)
	if info, err := os.Stat(opts.PartialPath); err == nil && info.Size() > 0 {
		downloaded = info.Size()
	}
	if sidecar := loadResumableSidecar(opts.PartialPath); sidecar != nil {
		total = sidecar.Total
	}
	opts.OnProgress(ResumableProgress{
		DownloadedBytes: downloaded,
		TotalBytes:      total,
		BytesPerSecond:  0,
		Attempt:         attemptNumber,
		State:           "retrying",
	})
}

func downloadResumableAttempt(ctx context.Context, parsed *url.URL, opts ResumableOptions, headerTimeout, idleTimeout time.Duration, attemptNumber int, freshConn bool) (ResumableFileResult, bool, error) {
	sidecar := loadResumableSidecar(opts.PartialPath)
	offset := int64(0)
	// Combining byte ranges requires a strong validator. Last-Modified alone
	// is not enough: this sidecar has no Date/clock evidence of its strength.
	if sidecar != nil && strongResumableETag(sidecar.ETag) && resumableSourceMatches(sidecar, parsed) {
		if info, err := os.Stat(opts.PartialPath); err == nil && info.Size() > 0 {
			offset = info.Size()
		}
	}
	if offset == 0 {
		// Keep the old cache until a full response can replace it. A failed
		// request (including an expired signed URL) must not discard its bytes.
		sidecar = nil
	}
	// If a prior attempt downloaded every byte but failed during local finalize
	// (e.g. transient AV lock on rename), finalize directly without issuing a
	// Range request at EOF that would 416 and re-download a 1-2 GiB file.
	if sidecar != nil && sidecar.Total > 0 && offset == sidecar.Total && offset < opts.MaxBytes {
		mimeType, sniffErr := resolveStreamedMimeType(opts.PartialPath, sidecar.MimeType)
		if sniffErr != nil {
			return ResumableFileResult{}, false, sniffErr
		}
		finalPath, renameErr := finalizeResumablePartial(opts.PartialPath)
		if renameErr != nil {
			return ResumableFileResult{}, false, renameErr
		}
		return ResumableFileResult{
			Path:     finalPath,
			Size:     offset,
			MimeType: mimeType,
			FileName: resumableFileName(parsed.Path),
		}, false, nil
	}
	sidecarTotal := int64(-1)
	if sidecar != nil {
		sidecarTotal = sidecar.Total
	}
	emitter := &resumableProgressEmitter{onProgress: opts.OnProgress, attempt: attemptNumber}
	emitter.observe(offset)
	emitter.emit(offset, sidecarTotal, "downloading", true)

	attemptCtx, stopHeader, cancel := WithHeaderTimeout(ctx, headerTimeout)
	defer cancel(nil)
	defer stopHeader()
	if freshConn {
		attemptCtx = WithFreshConnection(attemptCtx)
	}

	request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return ResumableFileResult{}, false, err
	}
	ApplyDefaultOutboundHeaders(request)
	for name, values := range opts.Headers {
		request.Header[name] = append([]string(nil), values...)
	}
	if offset > 0 && sidecar != nil {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		request.Header.Set("If-Range", sidecar.ETag)
	}
	if freshConn || requiresFreshConnection(attemptCtx) {
		request.Close = true
	}
	client := OutboundHTTPClient(0)
	checkRedirect := client.CheckRedirect
	leftOrigin := false
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if err := checkRedirect(next, via); err != nil {
			return err
		}
		if !strings.EqualFold(next.URL.Scheme, parsed.Scheme) || !strings.EqualFold(next.URL.Host, parsed.Host) {
			leftOrigin = true
		}
		if leftOrigin {
			for name := range opts.Headers {
				next.Header.Del(name)
			}
			next.Header.Del("Authorization")
			next.Header.Del("Cookie")
			next.Header.Del("Proxy-Authorization")
		}
		return nil
	}
	open := client.Do
	if opts.OpenResponse != nil {
		open = opts.OpenResponse
	}
	response, err := open(request)
	stopHeader()
	if err != nil {
		return ResumableFileResult{}, true, resumableTransferError(attemptCtx, err)
	}
	defer response.Body.Close()

	total := int64(-1)
	pending := resumableSidecar{
		URL:          resumableSourceURL(parsed),
		ETag:         response.Header.Get("ETag"),
		LastModified: response.Header.Get("Last-Modified"),
		MimeType:     normalizeResumableMimeType(response.Header.Get("Content-Type")),
	}
	switch response.StatusCode {
	case http.StatusRequestedRangeNotSatisfiable:
		removeResumablePartial(opts.PartialPath)
		return ResumableFileResult{}, true, fmt.Errorf("%w：%s", ErrResumeRestart, response.Status)
	case http.StatusOK:
		// The server ignored Range, or the validator changed. Restart from zero.
		offset = 0
		if declared := response.ContentLength; declared >= 0 {
			total = declared
		}
	case http.StatusPartialContent:
		if offset > 0 && sidecar != nil && strongResumableETag(sidecar.ETag) && response.Header.Get("ETag") != sidecar.ETag {
			removeResumablePartial(opts.PartialPath)
			return ResumableFileResult{}, true, fmt.Errorf("%w：标识已变化", ErrResumeRestart)
		}
		start, contentTotal, ok := parseContentRange(response.Header.Get("Content-Range"))
		if !ok || start != offset {
			removeResumablePartial(opts.PartialPath)
			return ResumableFileResult{}, true, fmt.Errorf("%w：断点位置不匹配", ErrResumeRestart)
		}
		// A known total that no longer matches means the remote object changed
		// size under the same validator; appending would corrupt the artifact.
		if sidecar != nil && sidecar.Total >= 0 && contentTotal >= 0 && sidecar.Total != contentTotal {
			removeResumablePartial(opts.PartialPath)
			return ResumableFileResult{}, true, fmt.Errorf("%w：总大小已变化", ErrResumeRestart)
		}
		total = contentTotal
	default:
		if retryableHTTPStatus(response.StatusCode) {
			return ResumableFileResult{}, true, &HTTPStatusError{StatusCode: response.StatusCode, Message: fmt.Sprintf("远程资源下载失败：%s", response.Status)}
		}
		// Expired signed links may later be refreshed for the same artifact.
		// Keep bytes, but require source/validator checks before any reuse.
		if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
			removeResumablePartial(opts.PartialPath)
		}
		return ResumableFileResult{}, false, &HTTPStatusError{StatusCode: response.StatusCode, Message: fmt.Sprintf("远程资源下载失败：%s", response.Status)}
	}
	pending.Total = total
	if total >= 0 && total >= opts.MaxBytes {
		removeResumablePartial(opts.PartialPath)
		return ResumableFileResult{}, false, ErrResourceTooLarge
	}
	file, err := os.OpenFile(opts.PartialPath, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return ResumableFileResult{}, false, err
	}
	if offset == 0 {
		if err := file.Truncate(0); err != nil {
			_ = file.Close()
			return ResumableFileResult{}, false, err
		}
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		_ = file.Close()
		return ResumableFileResult{}, false, err
	}
	// A full response replaces the old representation: discard its bytes before
	// publishing the new validator. Never stream without successfully saving the
	// matching sidecar, or a later retry could combine two different artifacts.
	if err := saveResumableSidecar(opts.PartialPath, pending); err != nil {
		_ = file.Close()
		return ResumableFileResult{}, false, err
	}
	emitter.observe(offset)
	emitter.emit(offset, total, "downloading", true)

	idleTimer := time.AfterFunc(idleTimeout, func() {
		cancel(fmt.Errorf("下载长时间没有收到数据：%w", context.DeadlineExceeded))
	})
	defer idleTimer.Stop()

	written, writeErr, readErr := copyStreamWithIdle(file, response.Body, offset, total, opts.MaxBytes, idleTimer, idleTimeout, emitter)
	idleTimer.Stop()
	closeErr := file.Close()
	if errors.Is(readErr, ErrResourceTooLarge) {
		removeResumablePartial(opts.PartialPath)
		return ResumableFileResult{}, false, ErrResourceTooLarge
	}
	if writeErr != nil {
		return ResumableFileResult{}, true, writeErr
	}
	if readErr == nil && closeErr != nil {
		readErr = closeErr
	}
	if readErr != nil {
		return ResumableFileResult{}, true, resumableTransferError(attemptCtx, readErr)
	}
	if total >= 0 && written != total {
		return ResumableFileResult{}, true, resumableConnectionDropError(io.ErrUnexpectedEOF)
	}

	mimeType, sniffErr := resolveStreamedMimeType(opts.PartialPath, response.Header.Get("Content-Type"))
	if sniffErr != nil {
		return ResumableFileResult{}, false, sniffErr
	}
	finalPath, renameErr := finalizeResumablePartial(opts.PartialPath)
	if renameErr != nil {
		return ResumableFileResult{}, false, renameErr
	}
	return ResumableFileResult{
		Path:     finalPath,
		Size:     written,
		MimeType: mimeType,
		FileName: resumableFileName(parsed.Path),
	}, false, nil
}

var resumableRenameFile = os.Rename

// finalizeResumablePartial atomically moves a completed .part file to a unique
// owned .complete-<random> sibling inside the per-path lock and deletes the
// .json sidecar. Exponential backoff retries handle transient Windows AV locks
// without triggering an HTTP re-download, and unique suffixes prevent concurrent
// callers from colliding on the same finalized path after the lock releases.
func finalizeResumablePartial(partialPath string) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	finalPath := partialPath + ".complete-" + hex.EncodeToString(suffix[:])
	backoff := 50 * time.Millisecond
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		if err := resumableRenameFile(partialPath, finalPath); err != nil {
			lastErr = err
			if attempt < 4 {
				time.Sleep(backoff)
				backoff *= 2
			}
			continue
		}
		_ = os.Remove(partialPath + ".json")
		return finalPath, nil
	}
	return "", lastErr
}

// SweepResumableArtifacts reclaims orphaned download/scratch artifacts older
// than maxAge inside dir (.part, .part.json, .part.complete-*, .beeftv-remux-*,
// plus legacy suffixes from older versions). Active downloads protected by
// lockResumableDownload are never removed.
func SweepResumableArtifacts(dir string, maxAge time.Duration) {
	dir = strings.TrimSpace(dir)
	if dir == "" || maxAge <= 0 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		name := entry.Name()
		isScratchDir := entry.IsDir() && (strings.HasPrefix(name, ".beeftv-remux-") || strings.HasPrefix(name, ".beeftv-probe-"))
		fullPath := filepath.Join(dir, name)
		partialKey, isArtifactFile := "", false
		if !entry.IsDir() {
			partialKey, isArtifactFile = resumableArtifactLockKey(fullPath, name)
		}
		if !isScratchDir && !isArtifactFile {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || info.ModTime().After(cutoff) {
			continue
		}
		if isScratchDir {
			_ = os.RemoveAll(fullPath)
			continue
		}
		unlock := lockResumableDownload(partialKey)
		if fresh, statErr := os.Stat(fullPath); statErr == nil && !fresh.ModTime().After(cutoff) {
			_ = os.Remove(fullPath)
		}
		unlock()
	}
}

func resumableArtifactLockKey(fullPath, name string) (string, bool) {
	switch {
	case strings.HasSuffix(name, ".part"):
		return fullPath, true
	case strings.HasSuffix(name, ".part.json"):
		return strings.TrimSuffix(fullPath, ".json"), true
	case strings.HasSuffix(name, ".complete"):
		return strings.TrimSuffix(fullPath, ".complete"), true
	case strings.HasPrefix(name, "beeftv-content-") && strings.HasSuffix(name, ".bin"):
		return fullPath, true
	}
	for _, marker := range []string{".part.complete-", ".part.done-"} {
		if idx := strings.Index(fullPath, marker); idx > 0 {
			return fullPath[:idx+len(".part")], true
		}
	}
	return "", false
}

const ResumableConnectionDropMessage = "生成结果下载失败：连接意外中断，请检查网络或代理设置后重试取回"

func resumableTransferError(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	// net/http includes the final signed URL in url.Error. Keep the transport
	// cause for classification, without persisting the artifact credential.
	var requestErr *url.Error
	for errors.As(err, &requestErr) {
		err = requestErr.Err
	}
	if IsConnectionDrop(err) {
		return resumableConnectionDropError(err)
	}
	return err
}

// IsConnectionDrop reports whether err represents an unexpected connection drop
// or premature EOF during transfer (such as a stale proxy/keep-alive socket).
func IsConnectionDrop(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || IsConnectionInterrupted(err)
}

func resumableConnectionDropError(err error) error {
	return fmt.Errorf("%s：%w", ResumableConnectionDropMessage, err)
}

func strongResumableETag(value string) bool {
	return len(value) >= 2 && strings.HasPrefix(value, "\"") && strings.HasSuffix(value, "\"")
}

func resumableSourceURL(source *url.URL) string {
	identity := *source
	identity.RawQuery, identity.Fragment, identity.User = "", "", nil
	return identity.String()
}

func resumableSourceMatches(sidecar *resumableSidecar, next *url.URL) bool {
	if sidecar.URL == next.String() {
		return true
	}
	previous, err := url.Parse(sidecar.URL)
	return err == nil && strongResumableETag(sidecar.ETag) && previous.Scheme == next.Scheme && previous.Host == next.Host && previous.EscapedPath() == next.EscapedPath()
}

func retryableHTTPStatus(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || (status >= 500 && status <= 599)
}

func normalizeResumableMimeType(value string) string {
	value = strings.TrimSpace(value)
	if idx := strings.Index(value, ";"); idx >= 0 {
		value = strings.TrimSpace(value[:idx])
	}
	return value
}

func resumableFileName(urlPath string) string {
	name := path.Base(urlPath)
	if name == "" || name == "." || name == "/" || !strings.Contains(name, ".") {
		return ""
	}
	return name
}

func parseContentRange(value string) (int64, int64, bool) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "bytes ") {
		return 0, 0, false
	}
	rest := strings.TrimPrefix(value, "bytes ")
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return 0, 0, false
	}
	rangePart := rest[:slash]
	totalPart := rest[slash+1:]
	dash := strings.Index(rangePart, "-")
	if dash < 0 {
		return 0, 0, false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(rangePart[:dash]), 10, 64)
	if err != nil {
		return 0, 0, false
	}
	if totalPart == "*" {
		return start, -1, true
	}
	total, err := strconv.ParseInt(strings.TrimSpace(totalPart), 10, 64)
	if err != nil {
		return start, -1, true
	}
	return start, total, true
}

func loadResumableSidecar(partialPath string) *resumableSidecar {
	raw, err := os.ReadFile(partialPath + ".json")
	if err != nil {
		return nil
	}
	var sidecar resumableSidecar
	if json.Unmarshal(raw, &sidecar) != nil {
		return nil
	}
	return &sidecar
}

func saveResumableSidecar(partialPath string, sidecar resumableSidecar) error {
	raw, err := json.Marshal(sidecar)
	if err != nil {
		return err
	}
	return os.WriteFile(partialPath+".json", raw, 0o600)
}

func removeResumablePartial(partialPath string) {
	_ = os.Remove(partialPath)
	_ = os.Remove(partialPath + ".json")
}

func waitResumableBackoff(ctx context.Context, attempt int) error {
	delay := time.Duration(1<<(attempt-1)) * time.Second
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type idleResetReader struct {
	body  io.Reader
	timer *time.Timer
	idle  time.Duration
}

func (r *idleResetReader) Read(p []byte) (int, error) {
	n, err := r.body.Read(p)
	if n > 0 {
		r.timer.Reset(r.idle)
	}
	return n, err
}

type resumableProgressEmitter struct {
	onProgress func(ResumableProgress)
	attempt    int
	sampler    resumableRateSampler
	lastEmit   time.Time
}

func (e *resumableProgressEmitter) observe(downloaded int64) {
	e.sampler.observe(time.Now(), downloaded)
}

func (e *resumableProgressEmitter) emit(downloaded, total int64, state string, force bool) {
	if e.onProgress == nil {
		return
	}
	now := time.Now()
	if !force && !e.lastEmit.IsZero() && now.Sub(e.lastEmit) < resumableProgressInterval {
		return
	}
	e.lastEmit = now
	e.onProgress(ResumableProgress{
		DownloadedBytes: downloaded,
		TotalBytes:      total,
		BytesPerSecond:  e.sampler.rate(now, downloaded),
		Attempt:         e.attempt,
		State:           state,
	})
}

type resumableRateSample struct {
	at         time.Time
	downloaded int64
}

// resumableRateSampler keeps a roughly 3s window of byte readings so the
// reported speed does not jump on every 32KB chunk.
type resumableRateSampler struct {
	samples []resumableRateSample
}

func (s *resumableRateSampler) observe(at time.Time, downloaded int64) {
	if n := len(s.samples); n > 0 && at.Sub(s.samples[n-1].at) < resumableRateSampleInterval {
		return
	}
	s.samples = append(s.samples, resumableRateSample{at: at, downloaded: downloaded})
	cutoff := at.Add(-resumableRateWindow)
	first := 0
	for first < len(s.samples) && s.samples[first].at.Before(cutoff) {
		first++
	}
	if first > 0 {
		s.samples = append([]resumableRateSample(nil), s.samples[first:]...)
	}
}

// ProgressRate applies the resumable-download speed smoothing to any byte
// counter, so generation transfers report speeds on the same scale.
type ProgressRate struct {
	sampler resumableRateSampler
}

func (r *ProgressRate) Observe(at time.Time, downloaded int64) {
	r.sampler.observe(at, downloaded)
}

func (r *ProgressRate) Rate(now time.Time, downloaded int64) int64 {
	return r.sampler.rate(now, downloaded)
}

func (s *resumableRateSampler) rate(now time.Time, downloaded int64) int64 {
	if len(s.samples) < 2 {
		return 0
	}
	oldest := s.samples[0]
	elapsed := now.Sub(oldest.at).Seconds()
	delta := downloaded - oldest.downloaded
	if elapsed <= 0 || delta <= 0 {
		return 0
	}
	return int64(float64(delta) / elapsed)
}

type resumableDownloadLock struct {
	mu   sync.Mutex
	refs int
}

var (
	resumableDownloadLocksMu sync.Mutex
	resumableDownloadLocks   = map[string]*resumableDownloadLock{}
)

// lockResumableDownload serializes downloads that share a .part path. The
// delivery coordinator and the 5s recovery loop can overlap on the same
// identity, and two writers on one .part file would corrupt the resume offset.
func lockResumableDownload(partialPath string) func() {
	resumableDownloadLocksMu.Lock()
	entry := resumableDownloadLocks[partialPath]
	if entry == nil {
		entry = &resumableDownloadLock{}
		resumableDownloadLocks[partialPath] = entry
	}
	entry.refs++
	resumableDownloadLocksMu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		resumableDownloadLocksMu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(resumableDownloadLocks, partialPath)
		}
		resumableDownloadLocksMu.Unlock()
	}
}
