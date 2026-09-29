package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsLoopbackRequestOriginRules(t *testing.T) {
	cases := []struct {
		name    string
		host    string
		remote  string
		origin  string
		allowed string
		want    bool
	}{
		{"no origin", "127.0.0.1:18090", "127.0.0.1:5555", "", "", true},
		{"same origin", "127.0.0.1:18090", "127.0.0.1:5555", "http://127.0.0.1:18090", "", true},
		{"other loopback port", "127.0.0.1:18090", "127.0.0.1:5555", "http://127.0.0.1:9999", "", false},
		{"fake localhost subdomain", "127.0.0.1:18090", "127.0.0.1:5555", "http://localhost.attacker.example", "", false},
		{"allowed product origin", "127.0.0.1:18090", "127.0.0.1:5555", "https://app.beeftv.local", "https://app.beeftv.local", true},
		{"non loopback remote", "127.0.0.1:18090", "10.0.0.9:5555", "", "", false},
		{"non loopback host", "evil.example:80", "127.0.0.1:5555", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("BEEFTV_ALLOWED_ORIGINS", tc.allowed)
			req := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/api/ops", nil)
			req.Host = tc.host
			req.RemoteAddr = tc.remote
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if got := isLoopbackRequest(req); got != tc.want {
				t.Fatalf("isLoopbackRequest=%v want %v", got, tc.want)
			}
		})
	}
}
