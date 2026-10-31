package networkcheck

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Result struct {
	Target             string    `json:"target"`
	Host               string    `json:"host"`
	Operation          string    `json:"operation"`
	Route              string    `json:"route"`
	Round              int       `json:"round"`
	StartedAt          time.Time `json:"started_at"`
	Finished           bool      `json:"finished"`
	ProxyUsed          bool      `json:"proxy_used"`
	DNSRole            string    `json:"dns_role"`
	Phase              string    `json:"phase"`
	ErrorCode          string    `json:"error_code,omitempty"`
	HTTPStatus         int       `json:"http_status,omitempty"`
	RequestID          string    `json:"request_id,omitempty"`
	RequestIDHeader    string    `json:"request_id_header,omitempty"`
	COSRequestID       string    `json:"cos_request_id,omitempty"`
	COSRequestIDHeader string    `json:"cos_request_id_header,omitempty"`
	DNSMS              int64     `json:"dns_ms"`
	DNSCount           int       `json:"dns_address_count"`
	DNSAddresses       []string  `json:"public_dns_addresses,omitempty"`
	PeerIP             string    `json:"public_peer_ip,omitempty"`
	PeerFamily         string    `json:"peer_family,omitempty"`
	ConnectMS          int64     `json:"connect_ms"`
	TLSMS              int64     `json:"tls_ms"`
	TLSVersion         string    `json:"tls_version,omitempty"`
	HTTPProtocol       string    `json:"http_protocol,omitempty"`
	FirstByteMS        int64     `json:"first_byte_ms"`
	TotalMS            int64     `json:"total_ms"`
	BodyOffered        int64     `json:"body_bytes_consumed_by_transport"`
	BodyRead           int64     `json:"body_bytes_read"`
	BodyTruncated      bool      `json:"body_truncated,omitempty"`
	ExpectedBytes      int64     `json:"expected_bytes,omitempty"`
	ContentLength      int64     `json:"response_content_length"`
	SHA256Match        bool      `json:"sha256_match,omitempty"`
}
type proxyFunc func(*http.Request) (*url.URL, error)
type probeRequest struct {
	target                   Target
	operation, method, route string
	round                    int
	headers                  map[string]string
	body                     []byte
	readLimit                int64
	expectedHash             string
	consentIP                bool
	diagnosticID             string
}
type probeEngine struct {
	proxy proxyFunc
	// Test seams stay private; production always uses verified TLS and its own dialer.
	dial      func(context.Context, string, string) (net.Conn, error)
	tlsConfig *tls.Config
}
type countingReader struct {
	r io.Reader
	n atomic.Int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, e := r.r.Read(p)
	r.n.Add(int64(n))
	return n, e
}

func (e probeEngine) probe(parent context.Context, p probeRequest, checkpoint func(Result)) (Result, []byte) {
	u, _ := url.Parse(p.target.URL)
	r := Result{Target: p.target.Name, Host: u.Hostname(), Operation: p.operation, Route: p.route, Round: p.round, StartedAt: time.Now().UTC(), Phase: "prepare", DNSMS: -1, ConnectMS: -1, TLSMS: -1, FirstByteMS: -1, ContentLength: -1, DNSRole: "origin"}
	if ip := net.ParseIP(r.Host); ip != nil && (!p.consentIP || publicIP(r.Host) == "") {
		r.Host = "IP omitted"
	}
	start := time.Now()
	var mu sync.Mutex
	active := true
	var dns, tcp, handshake time.Time
	update := func(fn func()) {
		mu.Lock()
		defer mu.Unlock()
		if !active {
			return
		}
		fn()
		snapshot := r
		snapshot.DNSAddresses = append([]string(nil), r.DNSAddresses...)
		if checkpoint != nil {
			checkpoint(snapshot)
		}
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	reader := &countingReader{r: bytes.NewReader(p.body)}
	req, err := http.NewRequestWithContext(ctx, p.method, p.target.URL, reader)
	if err != nil {
		r.Finished = true
		r.ErrorCode = "invalid_target"
		return r, nil
	}
	req.ContentLength = int64(len(p.body))
	if len(p.body) == 0 {
		req.Body = nil
	}
	for k, v := range p.headers {
		if k != "Content-Length" {
			req.Header.Set(k, v)
		}
	}
	req.Header.Set("User-Agent", "BeefTV-ConnectivityCheck/"+Version)
	req.Header.Set("X-BeefTV-Diagnostic-ID", p.diagnosticID)
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 8 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 12 * time.Second, DisableKeepAlives: true, ForceAttemptHTTP2: true, TLSClientConfig: e.tlsConfig}
	if e.dial != nil {
		transport.DialContext = e.dial
	}
	defer transport.CloseIdleConnections()
	if p.route == "beeftv" && e.proxy != nil {
		selected, proxyErr := e.proxy(req)
		if proxyErr != nil {
			r.ErrorCode = "proxy_configuration_error"
			r.Finished = true
			return r, nil
		}
		r.ProxyUsed = selected != nil
		transport.Proxy = http.ProxyURL(selected)
		if r.ProxyUsed {
			r.DNSRole = "proxy; origin DNS not observed locally"
		}
	}
	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { update(func() { r.Phase = "dns"; dns = time.Now() }) },
		DNSDone: func(info httptrace.DNSDoneInfo) {
			update(func() {
				r.DNSMS = time.Since(dns).Milliseconds()
				r.DNSCount = len(info.Addrs)
				if info.Err != nil {
					r.Phase = "dns"
				}
				if p.consentIP {
					for _, a := range info.Addrs {
						if ip := publicIP(a.IP.String()); ip != "" {
							r.DNSAddresses = append(r.DNSAddresses, ip)
						}
					}
				}
			})
		},
		ConnectStart: func(network, _ string) {
			if strings.HasPrefix(network, "tcp") {
				update(func() { r.Phase = "tcp"; tcp = time.Now() })
			}
		},
		ConnectDone: func(network, _ string, err error) {
			if strings.HasPrefix(network, "tcp") {
				update(func() {
					r.ConnectMS = time.Since(tcp).Milliseconds()
					if err == nil {
						r.Phase = "proxy_or_tls"
					}
				})
			}
		},
		TLSHandshakeStart: func() { update(func() { r.Phase = "tls"; handshake = time.Now() }) },
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			update(func() {
				r.TLSMS = time.Since(handshake).Milliseconds()
				if err == nil {
					r.TLSVersion = tls.VersionName(state.Version)
				}
			})
		},
		GotConn: func(info httptrace.GotConnInfo) {
			update(func() {
				r.Phase = "write_request"
				host, _, _ := net.SplitHostPort(info.Conn.RemoteAddr().String())
				if ip := net.ParseIP(host); ip != nil {
					if ip.To4() != nil {
						r.PeerFamily = "IPv4"
					} else {
						r.PeerFamily = "IPv6"
					}
					if p.consentIP {
						r.PeerIP = publicIP(host)
					}
				}
			})
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			update(func() {
				if info.Err == nil {
					r.Phase = "wait_response"
				}
			})
		},
		GotFirstResponseByte: func() { update(func() { r.FirstByteMS = time.Since(start).Milliseconds() }) },
	}
	req = req.WithContext(httptrace.WithClientTrace(ctx, trace))
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	var data []byte
	if resp != nil {
		update(func() {
			r.HTTPStatus = resp.StatusCode
			r.RequestID, r.RequestIDHeader = responseID(resp.Header, "X-Oneapi-Request-Id", "X-Request-Id")
			r.COSRequestID, r.COSRequestIDHeader = responseID(resp.Header, "X-Cos-Request-Id", "X-Amz-Request-Id")
			r.HTTPProtocol = resp.Proto
			r.ContentLength = resp.ContentLength
			r.Phase = "read_response"
		})
		if err == nil {
			data, err = io.ReadAll(io.LimitReader(resp.Body, p.readLimit+1))
			if int64(len(data)) > p.readLimit && p.expectedHash != "" {
				err = errReadLimit
			}
		}
		_ = resp.Body.Close()
	}
	mu.Lock()
	defer mu.Unlock()
	active = false
	r.BodyOffered = reader.n.Load()
	r.BodyRead = int64(len(data))
	r.BodyTruncated = int64(len(data)) > p.readLimit
	r.TotalMS = time.Since(start).Milliseconds()
	r.Finished = true
	if err != nil {
		r.ErrorCode = networkErrorCode(err, r.Phase)
		if r.ErrorCode == "dns_failed" || r.ErrorCode == "dns_timeout" {
			r.Phase = "dns"
		}
	} else {
		r.Phase = "http_response"
	}
	if p.expectedHash != "" {
		r.ExpectedBytes = p.readLimit
		if err == nil && r.HTTPStatus == 200 {
			r.SHA256Match = int64(len(data)) == p.readLimit && digest(data) == p.expectedHash
			if !r.SHA256Match {
				r.ErrorCode = "content_mismatch"
				r.Phase = "verify_content"
			}
		}
	}
	return r, data
}

var errReadLimit = errors.New("response limit")

func responseID(h http.Header, names ...string) (string, string) {
	for _, name := range names {
		if id := safeID(h.Get(name)); id != "" {
			return id, name
		}
	}
	return "", ""
}

func networkErrorCode(err error, phase string) string {
	var dns *net.DNSError
	if errors.As(err, &dns) {
		if dns.IsTimeout {
			return "dns_timeout"
		}
		return "dns_failed"
	}
	var cert *tls.CertificateVerificationError
	var unknown x509.UnknownAuthorityError
	var host x509.HostnameError
	if errors.As(err, &cert) || errors.As(err, &unknown) || errors.As(err, &host) {
		return "tls_certificate_error"
	}
	if errors.Is(err, errReadLimit) {
		return "response_limit"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	var n net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &n) && n.Timeout() {
		return phase + "_timeout"
	}
	return phase + "_failed"
}
func publicIP(raw string) string {
	ip, err := netip.ParseAddr(raw)
	if err != nil {
		return ""
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || netip.MustParsePrefix("100.64.0.0/10").Contains(ip) {
		return ""
	}
	return ip.String()
}
