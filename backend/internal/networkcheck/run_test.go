package networkcheck

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixtureRunner(t *testing.T) *runner {
	t.Helper()
	return &runner{base: filepath.Join(t.TempDir(), "report"), cancel: func() {}, report: Report{Schema: 2, State: "running", DiagnosticID: "0123456789abcdef0123456789abcdef", TrafficLimitBytes: TrafficLimit}}
}
func TestLostPutReceiptRecoversSameObjectAndCleansOnlyItsKeys(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	puts := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/"+SessionPrefix) {
			t.Error("request escaped namespace")
		}
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("X-Cos-Request-Id", "owned-fixture-123")
		switch r.Method {
		case "PUT":
			b, _ := io.ReadAll(r.Body)
			puts[r.URL.Path]++
			objects[r.URL.Path] = b
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
		case "HEAD":
			if b, ok := objects[r.URL.Path]; ok {
				w.Header().Set("Content-Length", intString(len(b)))
			} else {
				w.WriteHeader(404)
			}
		case "GET":
			if b, ok := objects[r.URL.Path]; ok {
				_, _ = w.Write(b)
			} else {
				w.WriteHeader(404)
			}
		case "DELETE":
			delete(objects, r.URL.Path)
			w.WriteHeader(204)
		default:
			t.Error("unexpected method")
		}
	}))
	defer server.Close()
	s := Session{ID: "0123456789abcdef0123456789abcdef", PutExpiresAt: time.Now().Add(time.Minute)}
	for _, route := range []string{"beeftv", "direct"} {
		for _, size := range []string{"small", "large"} {
			o := Object{Route: route, Size: size, Requests: map[string]Capability{}}
			for _, method := range []string{"PUT", "HEAD", "GET", "DELETE"} {
				o.Requests[method] = Capability{URL: server.URL + "/" + objectKey(s.ID, route, size) + "?secret=CAPABILITY_CANARY"}
			}
			s.Objects = append(s.Objects, o)
		}
	}
	r := fixtureRunner(t)
	r.transfers(context.Background(), s)
	for _, tr := range r.report.Transfers {
		if tr.Outcome != "verified_after_unconfirmed_put" {
			t.Fatal(tr)
		}
	}
	r.cleanup(context.Background(), s)
	mu.Lock()
	defer mu.Unlock()
	if len(objects) != 0 || len(puts) != 4 {
		t.Fatal("objects not cleaned or missing probes")
	}
	for _, n := range puts {
		if n != 1 {
			t.Fatal("PUT replayed")
		}
	}
	for _, tr := range r.report.Transfers {
		if tr.Cleanup != "absent_now; operator_final_cleanup_pending" {
			t.Fatal(tr)
		}
	}
	if r.report.TrafficBytes > TrafficLimit {
		t.Fatal("budget exceeded")
	}
	if err := writeBundle(r.base, r.report); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(r.base + ".zip")
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	if len(z.File) != 3 {
		t.Fatal("unexpected archive entries")
	}
	for _, f := range z.File {
		rd, _ := f.Open()
		b, _ := io.ReadAll(rd)
		_ = rd.Close()
		for _, secret := range []string{"CAPABILITY_CANARY", "?secret=", "127.0.0.1", "Authorization", "X-Amz-Credential"} {
			if strings.Contains(string(b), secret) {
				t.Fatalf("%s leaked %s", f.Name, secret)
			}
		}
	}
}
func TestBudgetAndCancelledRunKeepHonestPartial(t *testing.T) {
	r := fixtureRunner(t)
	r.report.TrafficBytes = TrafficLimit
	res, _ := r.request(context.Background(), probeRequest{target: Target{Name: "not called", URL: "https://not-called.invalid/"}, method: "GET", readLimit: 4096})
	if res.ErrorCode != "traffic_budget_exhausted" {
		t.Fatal(res)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	base, err := Run(ctx, Options{Configuration: Configuration{Targets: []Target{{Name: "API", URL: "https://example.com/api/status"}}}, OutputDir: t.TempDir(), Rounds: 3})
	if err != nil {
		t.Fatal(err)
	}
	var report Report
	if err := readJSON(base+".json", &report, 1<<20); err != nil {
		t.Fatal(err)
	}
	if report.State != "partial" || len(report.Results) != 0 || report.SessionStatus != "missing; transfer not measured" || report.IPConsent || len(report.Egress) > 0 {
		t.Fatal(report)
	}
	if _, err := os.Stat(base + ".zip"); err != nil {
		t.Fatal(err)
	}
}
func TestCheckpointSubprocess(t *testing.T) {
	if os.Getenv("BEEFTV_CHECKPOINT_CHILD") != "1" {
		return
	}
	r := &runner{base: os.Getenv("BEEFTV_CHECKPOINT_BASE"), cancel: func() {}, report: Report{Schema: 2, State: "running"}}
	r.request(context.Background(), probeRequest{target: Target{Name: "fixture", URL: os.Getenv("BEEFTV_CHECKPOINT_URL")}, method: "GET", route: "direct", readLimit: 4096})
}
func TestForceKillLeavesParseableCheckpoint(t *testing.T) {
	entered := make(chan struct{}, 1)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { entered <- struct{}{}; <-r.Context().Done() }))
	defer s.Close()
	base := filepath.Join(t.TempDir(), "partial")
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestCheckpointSubprocess$")
	cmd.Env = append(os.Environ(), "BEEFTV_CHECKPOINT_CHILD=1", "BEEFTV_CHECKPOINT_BASE="+base, "BEEFTV_CHECKPOINT_URL="+s.URL+"/?signature=SECRET_CANARY")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not reach fixture")
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	b, err := os.ReadFile(base + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var r Report
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	if r.State != "running" || len(r.Results) != 1 || r.Results[0].Finished || strings.Contains(string(b), "SECRET_CANARY") {
		t.Fatal("lost or unsafe checkpoint")
	}
}
