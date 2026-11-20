package desktopupdate

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

const (
	feedMaxStalls     = 3
	downloadMaxStalls = 5
)

// netFailure pairs the message a user can act on with the raw cause, which
// only goes to the local update log.
type netFailure struct {
	public    error
	cause     error
	retryable bool
}

func (f *netFailure) Error() string { return f.public.Error() }
func (f *netFailure) Unwrap() error { return f.public }

func failure(public, cause error, retryable bool) error {
	return &netFailure{public: public, cause: cause, retryable: retryable}
}

func isRetryable(err error) bool {
	var f *netFailure
	return errors.As(err, &f) && f.retryable
}

func rawCause(err error) error {
	var f *netFailure
	if errors.As(err, &f) && f.cause != nil {
		return f.cause
	}
	return err
}

var errInsecureUpdateURL = errors.New("更新地址必须使用 HTTPS")

func classifyTransportError(err error, idle bool) error {
	if err == nil {
		return nil
	}
	var f *netFailure
	if errors.As(err, &f) {
		return err
	}
	if idle {
		return failure(ErrTimeout, err, true)
	}
	if errors.Is(err, errInsecureUpdateURL) {
		return errInsecureUpdateURL
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	var opErr *net.OpError
	if (errors.As(err, &opErr) && opErr.Op == "proxyconnect") || strings.Contains(err.Error(), "proxyconnect") {
		return failure(ErrProxyUnavailable, err, false)
	}
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verification *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	if errors.As(err, &unknownAuthority) || errors.As(err, &hostname) || errors.As(err, &invalid) || errors.As(err, &verification) || errors.As(err, &record) {
		return failure(ErrSecureConnection, err, false)
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return failure(ErrTimeout, err, true)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return failure(ErrTimeout, err, true)
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		return failure(ErrNetworkOffline, err, true)
	}
	// Resets, EOFs, HTTP/2 stream errors and anything else from the transport
	// are what an unstable cross-border link looks like; retrying is safe
	// because every byte is verified against the signed hash afterwards.
	return failure(ErrConnectionDropped, err, true)
}

func classifyStatus(code int) error {
	cause := fmt.Errorf("HTTP %d", code)
	switch {
	case code == http.StatusRequestTimeout || code == http.StatusTooManyRequests || code >= 500:
		return failure(ErrServerBusy, cause, true)
	default:
		return failure(ErrServerBusy, cause, false)
	}
}

func defaultRetryBackoff(stall int) time.Duration {
	if stall < 1 {
		stall = 1
	}
	if stall > 4 {
		return 15 * time.Second
	}
	return time.Second << (stall - 1)
}

// retry repeats attempt until it succeeds, fails permanently, or fails
// maxStalls times in a row without moving any bytes. A slow link that keeps
// making progress is never abandoned.
func (e *Engine) retry(ctx context.Context, phase string, maxStalls int, attempt func() (progressed bool, err error)) error {
	stalls := 0
	for n := 1; ; n++ {
		progressed, err := attempt()
		if err == nil {
			return nil
		}
		e.logf("%s attempt=%d failed: %v", phase, n, rawCause(err))
		if !isRetryable(err) || ctx.Err() != nil {
			return err
		}
		if progressed {
			stalls = 0
		}
		stalls++
		if stalls >= maxStalls {
			return err
		}
		if phase == actionDownload {
			e.set(func(state *UpdateState) { state.Reconnecting = true })
		}
		timer := time.NewTimer(e.retryBackoff(stalls))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

var networkSentinels = []error{ErrNetworkUnstable, ErrProxyUnavailable, ErrNetworkOffline, ErrSecureConnection, ErrServerBusy, ErrConnectionDropped}

func networkSentinel(err error) error {
	for _, sentinel := range networkSentinels {
		if errors.Is(err, sentinel) {
			return sentinel
		}
	}
	return nil
}
