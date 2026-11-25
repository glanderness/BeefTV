package outbound

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// WithHeaderTimeout creates a cancelable child context that aborts with a
// standardized response-header deadline error if stop() is not called in time.
func WithHeaderTimeout(ctx context.Context, timeout time.Duration) (context.Context, func(), context.CancelCauseFunc) {
	if timeout <= 0 {
		timeout = defaultResumableHeaderTimeout
	}
	reqCtx, cancel := context.WithCancelCause(ctx)
	timer := time.AfterFunc(timeout, func() {
		cancel(fmt.Errorf("等待下载响应超时：%w", context.DeadlineExceeded))
	})
	return reqCtx, func() { timer.Stop() }, cancel
}

// StreamFileOptions configures StreamResponseToFile for non-resumable responses
// (such as direct 200 /content responses or non-GET protocol result endpoints).
type StreamFileOptions struct {
	Dir         string
	MaxBytes    int64         // exclusive byte cap (use ExclusiveByteLimit); <=0 means unlimited
	IdleTimeout time.Duration // defaults to defaultResumableIdleTimeout when <=0
	Cancel      func()        // optional callback to also cancel the in-flight request when IdleTimeout fires
}

// StreamResponseToFile streams an opened HTTP response body to a unique *.part
// file inside opts.Dir (or OS temp when empty), enforcing MaxBytes and idle
// stall timeouts through the same core reader loop as DownloadResumableToFile.
// The caller owns the returned Path and must remove it when done.
func StreamResponseToFile(ctx context.Context, resp *http.Response, opts StreamFileOptions) (ResumableFileResult, error) {
	if resp == nil || resp.Body == nil {
		return ResumableFileResult{}, errors.New("远程响应为空")
	}
	if opts.MaxBytes > 0 && resp.ContentLength >= opts.MaxBytes {
		return ResumableFileResult{}, ErrResourceTooLarge
	}
	dir := strings.TrimSpace(opts.Dir)
	if dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return ResumableFileResult{}, err
		}
	}
	tmp, err := os.CreateTemp(dir, "stream-*.part")
	if err != nil {
		return ResumableFileResult{}, err
	}
	tmpPath, keep := tmp.Name(), false
	defer func() {
		if !keep {
			_ = os.Remove(tmpPath)
		}
	}()

	idleTimeout := opts.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultResumableIdleTimeout
	}
	var stalled atomic.Bool
	idleTimer := time.AfterFunc(idleTimeout, func() {
		stalled.Store(true)
		if opts.Cancel != nil {
			opts.Cancel()
		}
		// Always close resp.Body so a blocked Read unblocks even if opts.Cancel
		// is nil or not wired to resp's underlying request context.
		_ = resp.Body.Close()
	})
	defer idleTimer.Stop()

	written, writeErr, readErr := copyStreamWithIdle(tmp, resp.Body, 0, resp.ContentLength, opts.MaxBytes, idleTimer, idleTimeout, nil)
	idleTimer.Stop()
	closeErr := tmp.Close()
	if errors.Is(readErr, ErrResourceTooLarge) {
		return ResumableFileResult{}, ErrResourceTooLarge
	}
	if writeErr != nil {
		return ResumableFileResult{}, writeErr
	}
	if readErr != nil {
		if stalled.Load() && ctx.Err() == nil {
			return ResumableFileResult{}, fmt.Errorf("下载长时间没有收到数据：%w", context.DeadlineExceeded)
		}
		if ctx.Err() != nil {
			return ResumableFileResult{}, ctx.Err()
		}
		return ResumableFileResult{}, resumableTransferError(ctx, readErr)
	}
	if closeErr != nil {
		return ResumableFileResult{}, closeErr
	}
	if resp.ContentLength >= 0 && !resp.Uncompressed && written != resp.ContentLength {
		return ResumableFileResult{}, resumableConnectionDropError(io.ErrUnexpectedEOF)
	}
	mimeType, sniffErr := resolveStreamedMimeType(tmpPath, resp.Header.Get("Content-Type"))
	if sniffErr != nil {
		return ResumableFileResult{}, sniffErr
	}
	var fileName string
	if resp.Request != nil && resp.Request.URL != nil {
		fileName = resumableFileName(resp.Request.URL.Path)
	}
	keep = true
	return ResumableFileResult{Path: tmpPath, Size: written, MimeType: mimeType, FileName: fileName}, nil
}

func copyStreamWithIdle(
	w io.Writer,
	body io.Reader,
	offset, total, maxBytes int64,
	idleTimer *time.Timer,
	idleTimeout time.Duration,
	emitter *resumableProgressEmitter,
) (written int64, writeErr, readErr error) {
	reader := &idleResetReader{body: body, timer: idleTimer, idle: idleTimeout}
	written = offset
	buffer := make([]byte, resumableReadBuffer)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			if maxBytes > 0 && written+int64(n) >= maxBytes {
				return written, nil, ErrResourceTooLarge
			}
			if _, wErr := w.Write(buffer[:n]); wErr != nil {
				return written, wErr, nil
			}
			written += int64(n)
			if emitter != nil {
				emitter.observe(written)
				emitter.emit(written, total, "downloading", false)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return written, nil, nil
			}
			return written, nil, err
		}
	}
}

func resolveStreamedMimeType(filePath, declared string) (string, error) {
	mimeType := normalizeResumableMimeType(declared)
	if mimeType != "" && mimeType != "application/octet-stream" {
		return mimeType, nil
	}
	sniff, err := ReadFilePrefix(filePath, 512)
	if err != nil {
		return "", err
	}
	return http.DetectContentType(sniff), nil
}

// ReadFilePrefix reads up to maxBytes from the start of path without loading
// the rest of the file into memory.
func ReadFilePrefix(path string, maxBytes int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, maxBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	return buf[:n], nil
}
