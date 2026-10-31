package networkcheck

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProbeConnectivityIDsTLSAndProxyPrivacy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "HEAD" || r.Header.Get("Authorization") != "" {
			t.Error("unexpected authenticated/generation request")
		}
		w.Header().Set("X-Request-Id", "api-123")
		w.Header().Set("X-Oneapi-Request-Id", "beefapi-123")
		w.Header().Set("X-Cos-Request-Id", "NTg3NzRiMjVfYmRjMzVfMTViMl82ZGZmNw==")
		w.WriteHeader(403)
	}))
	defer server.Close()
	p := probeRequest{target: Target{Name: "COS", URL: server.URL}, method: "HEAD", route: "direct", operation: "https_connectivity", readLimit: 4096}
	r, _ := (probeEngine{}).probe(context.Background(), p, nil)
	if r.ErrorCode != "" || r.HTTPStatus != 403 || r.RequestID != "beefapi-123" || r.RequestIDHeader != "X-Oneapi-Request-Id" || r.COSRequestID != "NTg3NzRiMjVfYmRjMzVfMTViMl82ZGZmNw==" || r.Phase != "http_response" || !r.Finished {
		t.Fatal(r)
	}
	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("untrusted certificate accepted") }))
	defer tlsServer.Close()
	p.target.URL = tlsServer.URL
	r, _ = (probeEngine{}).probe(context.Background(), p, nil)
	if r.ErrorCode != "tls_certificate_error" {
		t.Fatal(r)
	}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("PROXY_USER_CANARY", "PROXY_PASSWORD_CANARY")
	p.target.URL = "http://must-not-resolve.invalid/"
	p.route = "beeftv"
	r, _ = (probeEngine{proxy: func(*http.Request) (*url.URL, error) { return proxyURL, nil }}).probe(context.Background(), p, nil)
	if !r.ProxyUsed || r.HTTPStatus != 401 || r.ErrorCode != "" || !strings.Contains(r.DNSRole, "origin DNS not observed") {
		t.Fatal(r)
	}
	b, _ := json.Marshal(r)
	for _, s := range []string{"PROXY_", proxy.URL, "127.0.0.1"} {
		if strings.Contains(string(b), s) {
			t.Fatal("proxy/private IP leaked")
		}
	}
	p.route = "direct"
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var calls atomic.Int32
	r, _ = (probeEngine{proxy: func(*http.Request) (*url.URL, error) { calls.Add(1); return proxyURL, nil }}).probe(ctx, p, nil)
	if calls.Load() != 0 || r.ProxyUsed || r.ErrorCode == "" {
		t.Fatal("direct consulted proxy")
	}
}

func TestResponseIDCompatibility(t *testing.T) {
	h := http.Header{}
	h.Set("X-Amz-Request-Id", "NTg3NzRiMjVfYmRjMzVfMTViMl82ZGZmNw==")
	id, source := responseID(h, "X-Cos-Request-Id", "X-Amz-Request-Id")
	if id == "" || source != "X-Amz-Request-Id" {
		t.Fatal("S3 compatible COS ID missing")
	}
	h.Set("X-Request-Id", "generic-123")
	id, source = responseID(h, "X-Oneapi-Request-Id", "X-Request-Id")
	if id != "generic-123" || source != "X-Request-Id" {
		t.Fatal("generic ID missing")
	}
	if safeID("secret\r\nHeader: value") != "" || safeID(strings.Repeat("A", 161)) != "" {
		t.Fatal("unsafe ID accepted")
	}
}
func TestActualUnansweredDNSStaysDNSAndPreservesPartial(t *testing.T) {
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	go func() {
		b := make([]byte, 4096)
		for {
			if _, _, err := udp.ReadFrom(b); err != nil {
				return
			}
		}
	}()
	resolver := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, udp.LocalAddr().String())
	}}
	e := probeEngine{dial: (&net.Dialer{Resolver: resolver}).DialContext}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	var sawDNS atomic.Bool
	r, _ := e.probe(ctx, probeRequest{target: Target{Name: "slow DNS", URL: "http://dns-canary.invalid/"}, method: "HEAD", route: "direct", readLimit: 4096}, func(r Result) {
		if r.Phase == "dns" {
			sawDNS.Store(true)
		}
	})
	if !sawDNS.Load() || r.Phase != "dns" || !strings.HasPrefix(r.ErrorCode, "dns_") || r.ConnectMS != -1 {
		t.Fatalf("DNS mislabeled as TCP: %+v", r)
	}
}
func TestCompleteBodyHashBoundsAndRedirect(t *testing.T) {
	var followed atomic.Int32
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/followed", 302)
		case "/followed":
			followed.Add(1)
		case "/truncated":
			w.Header().Set("Content-Length", "10")
			_, _ = w.Write([]byte("short"))
		default:
			_, _ = w.Write([]byte("1234567890"))
		}
	}))
	defer s.Close()
	e := probeEngine{tlsConfig: s.Client().Transport.(*http.Transport).TLSClientConfig.Clone()}
	p := probeRequest{target: Target{Name: "read", URL: s.URL}, method: "GET", route: "direct", readLimit: 10, expectedHash: digest([]byte("1234567890"))}
	r, _ := e.probe(context.Background(), p, nil)
	if !r.SHA256Match || r.ErrorCode != "" || r.BodyRead != 10 || r.TLSVersion != tls.VersionName(tls.VersionTLS13) {
		t.Fatal(r)
	}
	p.readLimit = 5
	r, _ = e.probe(context.Background(), p, nil)
	if r.ErrorCode != "response_limit" || r.BodyRead != 6 {
		t.Fatal(r)
	}
	p.target.URL = s.URL + "/truncated"
	p.readLimit = 10
	r, _ = e.probe(context.Background(), p, nil)
	if r.ErrorCode == "" || r.SHA256Match || r.Phase != "read_response" {
		t.Fatal(r)
	}
	p.target.URL = s.URL + "/redirect"
	p.expectedHash = ""
	r, _ = e.probe(context.Background(), p, nil)
	if r.HTTPStatus != 302 || followed.Load() != 0 {
		t.Fatal("redirect followed")
	}
}
func TestRawProxyErrorIsNeverExported(t *testing.T) {
	e := probeEngine{proxy: func(*http.Request) (*url.URL, error) { return nil, fmt.Errorf("SECRET_CANARY") }}
	r, _ := e.probe(context.Background(), probeRequest{target: Target{Name: "x", URL: "https://example.com/"}, route: "beeftv", method: "HEAD"}, nil)
	b, _ := json.Marshal(r)
	if r.ErrorCode != "proxy_configuration_error" || strings.Contains(string(b), "SECRET_CANARY") {
		t.Fatal(r)
	}
}
