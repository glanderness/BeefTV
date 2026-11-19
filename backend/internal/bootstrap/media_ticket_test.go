package bootstrap

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoopbackMediaTicketStreamingAndSecurity(t *testing.T) {
	rt, err := Open(t.Context(), Config{
		Profile:     ProfileDesktop,
		DataDir:     t.TempDir(),
		ListenAddr:  "127.0.0.1:0",
		LaunchToken: "master-desktop-secret-token",
		AutoMigrate: true,
	})
	if err != nil {
		t.Fatalf("open desktop runtime: %v", err)
	}
	defer rt.Close(t.Context())

	// Seed a local video resource directly via ResourceService.
	videoPayload := bytes.Repeat([]byte("0123456789ABCDEF"), 16384) // 256 KiB
	owner, err := rt.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	res, _, err := rt.service.ResourceService().Store(
		owner.ID, "video", "clip.mp4", "video/mp4", int64(len(videoPayload)), 1280, 720, 5000, bytes.NewReader(videoPayload), nil,
	)
	if err != nil {
		t.Fatalf("store video: %v", err)
	}

	// 1. Mint ticket through authenticated desktop API.
	req := httptest.NewRequest(http.MethodPost, "/api/resources/"+res.ID+"/media-ticket", strings.NewReader(`{"variant":"original"}`))
	req.RemoteAddr = "127.0.0.1:51234"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Desktop-Token", rt.LaunchToken())
	rec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("mint ticket status=%d body=%s", rec.Code, rec.Body.String())
	}
	var minted struct {
		Code int `json:"code"`
		Data struct {
			Ticket string `json:"ticket"`
			Path   string `json:"path"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if minted.Code != 0 || !strings.HasPrefix(minted.Data.Path, "/media/") || !strings.HasSuffix(minted.Data.Path, ".mp4") {
		t.Fatalf("unexpected minted ticket payload: %+v", minted)
	}
	if strings.Contains(minted.Data.Path, rt.LaunchToken()) {
		t.Fatal("media ticket URL must never contain master launch token")
	}

	// 2. Safari 2-byte Range probe without X-Desktop-Token succeeds over loopback.
	probeReq := httptest.NewRequest(http.MethodGet, minted.Data.Path, nil)
	probeReq.RemoteAddr = "127.0.0.1:51235"
	probeReq.Header.Set("Range", "bytes=0-1")
	probeReq.Header.Set("Origin", "http://wails.localhost")
	probeRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(probeRec, probeReq)
	if probeRec.Code != http.StatusPartialContent {
		t.Fatalf("Range probe status=%d body=%s", probeRec.Code, probeRec.Body.String())
	}
	if got := probeRec.Header().Get("Content-Range"); got != "bytes 0-1/262144" {
		t.Fatalf("Content-Range=%q want bytes 0-1/262144", got)
	}
	if got := probeRec.Body.String(); got != "01" {
		t.Fatalf("Range body=%q want 01", got)
	}
	if got := probeRec.Header().Get("Access-Control-Allow-Origin"); got != "http://wails.localhost" {
		t.Fatalf("CORS allow-origin=%q", got)
	}

	// 3. Stale If-Range must NOT degrade a mid-file seek into full-file 200.
	seekReq := httptest.NewRequest(http.MethodGet, minted.Data.Path, nil)
	seekReq.RemoteAddr = "127.0.0.1:51236"
	seekReq.Header.Set("Range", "bytes=16-31")
	seekReq.Header.Set("If-Range", `"stale-etag"`)
	seekRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(seekRec, seekReq)
	if seekRec.Code != http.StatusPartialContent || seekRec.Body.Len() != 16 {
		t.Fatalf("seek with stale If-Range got status=%d len=%d", seekRec.Code, seekRec.Body.Len())
	}

	// 4. Non-loopback client rejected 403.
	remoteReq := httptest.NewRequest(http.MethodGet, minted.Data.Path, nil)
	remoteReq.RemoteAddr = "192.168.1.99:51237"
	remoteRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(remoteRec, remoteReq)
	if remoteRec.Code != http.StatusForbidden {
		t.Fatalf("expected non-loopback 403, got %d", remoteRec.Code)
	}

	// 5. Mutation method rejected 405.
	postReq := httptest.NewRequest(http.MethodPost, minted.Data.Path, nil)
	postReq.RemoteAddr = "127.0.0.1:51238"
	postRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected POST 405, got %d", postRec.Code)
	}

	// 6. Ticket cannot bypass /api/* desktop token auth.
	apiReq := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
	apiReq.RemoteAddr = "127.0.0.1:51239"
	apiReq.Header.Set("X-Desktop-Token", minted.Data.Ticket)
	apiRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(apiRec, apiReq)
	if apiRec.Code != http.StatusForbidden {
		t.Fatalf("ticket must not authenticate /api/*, got %d", apiRec.Code)
	}

	// 7. Missing resources return clean 404 (never 500) on both preview and ticket routes.
	missingPreviewReq := httptest.NewRequest(http.MethodGet, "/api/resources/missing-resource-id/asset/preview-512.jpg", nil)
	missingPreviewReq.Header.Set("X-Desktop-Token", rt.LaunchToken())
	missingPreviewRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(missingPreviewRec, missingPreviewReq)
	if missingPreviewRec.Code != http.StatusNotFound {
		t.Fatalf("missing resource preview got %d, want 404: %s", missingPreviewRec.Code, missingPreviewRec.Body.String())
	}

	missingTicketReq := httptest.NewRequest(http.MethodPost, "/api/resources/missing-resource-id/media-ticket", nil)
	missingTicketReq.Header.Set("X-Desktop-Token", rt.LaunchToken())
	missingTicketRec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(missingTicketRec, missingTicketReq)
	if missingTicketRec.Code != http.StatusNotFound {
		t.Fatalf("missing resource ticket got %d, want 404: %s", missingTicketRec.Code, missingTicketRec.Body.String())
	}
}
