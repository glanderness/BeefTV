package aihubkit

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/generation"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDashboardLoginUsesPrivateCookieJar(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("dashboard login unexpectedly sent bearer token")
		}
		switch r.URL.Path {
		case "/api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "dashboard-secret", Path: "/"})
			io.WriteString(w, `{"success":true,"data":{"id":7,"status":1,"group":"video","username":"creator"}}`)
		case "/api/user/token":
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "dashboard-secret" || r.Header.Get("New-Api-User") != "7" {
				t.Error("missing login cookie or user header")
			}
			io.WriteString(w, `{"success":true,"data":"management-secret"}`)
		default:
			t.Error("unexpected endpoint")
		}
	}))
	defer server.Close()
	c := &client{origin: server.URL, http: server.Client()}
	user, token, err := c.login(context.Background(), "creator", "password")
	if err != nil || user.ID != 7 || token != "management-secret" {
		t.Fatalf("login: user=%+v err=%v", user, err)
	}
	if c.http.Jar != nil {
		t.Fatal("dashboard cookies escaped the login client")
	}
}

func TestAccountKeysAreEncryptedAndReusedPerGroup(t *testing.T) {
	var created atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/token/" || r.Header.Get("Authorization") != "Bearer management-secret" || r.Header.Get("New-Api-User") != "7" {
			t.Error("invalid token creation request")
		}
		created.Add(1)
		io.WriteString(w, `{"success":true,"data":{"key":"inference-secret"}}`)
	}))
	defer server.Close()
	a := &account{dir: t.TempDir(), client: &client{origin: server.URL, http: server.Client()}, user: User{ID: 7}, token: "management-secret", groups: map[string]Group{"video": {}}, keys: map[string]string{}}
	if err := a.ensureKey(context.Background(), "unknown"); err == nil {
		t.Fatal("unauthorized group accepted")
	}
	if err := a.ensureKey(context.Background(), "video"); err != nil {
		t.Fatal(err)
	}
	if err := a.ensureKey(context.Background(), "video"); err != nil || created.Load() != 1 {
		t.Fatalf("key was recreated: %v", err)
	}
	_, key, handled, err := a.resolve("aihubkit:video")
	if err != nil || !handled || key != "sk-inference-secret" {
		t.Fatal("inference key resolution failed")
	}
	b, err := os.ReadFile(filepath.Join(a.dir, "aihubkit-keys.enc"))
	if err != nil || strings.Contains(string(b), "inference-secret") || strings.Contains(string(b), "management-secret") {
		t.Fatal("credentials stored in plaintext")
	}
	if accountScope(Origin, 7) == accountScope(Origin, 8) || accountScope(Origin, 7) == accountScope("https://other.example", 7) {
		t.Fatal("account namespace collision")
	}
}

func TestUploadUsesGeneralFileTypesAndNoAccountCredentialsAtObjectStore(t *testing.T) {
	for _, mime := range []string{"image/png", "video/mp4", "audio/wav", "application/pdf"} {
		t.Run(mime, func(t *testing.T) {
			c := newClient()
			c.http = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/v1/temporary-files" || r.Header.Get("Authorization") != "Bearer management-secret" {
					t.Fatal("invalid ticket request")
				}
				var input map[string]any
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Fatal(err)
				}
				if input["content_type"] != mime || input["size"] != float64(3) {
					t.Fatal("file metadata changed")
				}
				ticket, _ := json.Marshal(map[string]any{"success": true, "data": uploadTicket{UploadURL: "https://8.8.8.8/put?signature=private", URL: "https://8.8.8.8/get?signature=private", ExpiresIn: 600, Headers: map[string]string{"Content-Type": mime}}})
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(ticket)))}, nil
			})}
			c.uploadHTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				b, _ := io.ReadAll(r.Body)
				if r.Method != "PUT" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Content-Type") != mime || r.ContentLength != 3 || string(b) != "abc" {
					t.Fatal("object PUT leaked credentials or changed file")
				}
				if _, ok := r.Context().Deadline(); !ok {
					t.Fatal("ticket deadline missing")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
			})
			link, deadline, err := c.upload(context.Background(), "management-secret", "file", mime, 3, strings.NewReader("abc"))
			if err != nil || link == "" || time.Until(deadline) < 9*time.Minute {
				t.Fatalf("upload: %v", err)
			}
		})
	}
}

func TestUploadRejectsPrivateTargetsAndExpiredBatches(t *testing.T) {
	c := newClient()
	c.http = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"data":{"upload_url":"https://127.0.0.1/private","url":"https://8.8.8.8/get","expires_in":600}}`))}, nil
	})}
	if _, _, err := c.upload(context.Background(), "secret", "file", "video/mp4", 1, strings.NewReader("a")); err == nil {
		t.Fatal("accepted private upload target")
	}
	s := &accountStorage{expiresAt: time.Now().Add(5 * time.Second)}
	if s.ValidateReferences(context.Background()) == nil {
		t.Fatal("accepted an expiring earlier reference")
	}
	s.expiresAt = time.Now().Add(time.Minute)
	if err := s.ValidateReferences(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestAccountReferenceStorageSupportsExistingHubChannelsOnly(t *testing.T) {
	a := &account{client: &client{origin: Origin}}
	for _, config := range []generation.Config{
		{BaseURL: Origin + "/v1"},
		{CredentialRef: credentialPrefix + "video", BaseURL: "https://other.example/v1"},
	} {
		if a.referenceStorage(config) == nil {
			t.Fatalf("expected account storage for %+v", config)
		}
	}
	for _, baseURL := range []string{
		"https://apimodel.aihubkit.com.evil.example/v1",
		"https://apimodel.aihubkit.com@evil.example/v1",
		"http://apimodel.aihubkit.com/v1",
		"https://other.example/v1",
	} {
		if a.referenceStorage(generation.Config{BaseURL: baseURL}) != nil {
			t.Fatalf("unexpected account storage for %q", baseURL)
		}
	}
}

func TestHostRequiresLoginAndRejectsForeignOrigins(t *testing.T) {
	h, err := Open(context.Background(), bootstrap.Config{Profile: bootstrap.ProfileServer, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(context.Background())
	for _, tc := range []struct {
		path, origin string
		status       int
	}{
		{"/api/workspace/bootstrap", "", 401},
		{apiPrefix + "session", "", 200},
		{apiPrefix + "session", "https://attacker.example", 403},
	} {
		r := httptest.NewRequest("GET", tc.path, nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		h.Handler().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s: status %d", tc.path, w.Code)
		}
		if strings.Contains(w.Body.String(), "management-secret") {
			t.Fatal("credential exposed")
		}
	}
}

func TestProtocolMappingRequiresExplicitContract(t *testing.T) {
	for _, tc := range []struct {
		endpoints            []string
		capability, protocol string
	}{
		{[]string{"openai-video"}, "video", "aihubkit-video"},
		{[]string{"openai", "image-generation"}, "image", "openai-image"},
		{[]string{"openai"}, "text", "chat-completion"},
		{nil, "", ""},
	} {
		capability, protocol := modelProtocol(CatalogModel{ID: "opaque-model", Endpoints: tc.endpoints})
		if capability != tc.capability || protocol != tc.protocol {
			t.Fatalf("unexpected mapping: %s %s", capability, protocol)
		}
	}
}

func TestAccountWorkspaceSurvivesLogoutAndIsIsolatedFromOtherAccounts(t *testing.T) {
	var created atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/user/login":
			var input struct{ Username string }
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			id := 7
			if input.Username == "second" {
				id = 8
			}
			http.SetCookie(w, &http.Cookie{Name: "dashboard", Value: strconv.Itoa(id), Path: "/"})
			json.NewEncoder(w).Encode(map[string]any{"success": true, "data": User{ID: id, Username: input.Username, Group: "video", Status: 1}})
		case "/api/user/token":
			cookie, err := r.Cookie("dashboard")
			if err != nil || cookie.Value != r.Header.Get("New-Api-User") {
				t.Error("login cookie and user ID must match")
			}
			io.WriteString(w, `{"success":true,"data":"management-secret"}`)
		case "/api/user/self/groups":
			io.WriteString(w, `{"success":true,"data":{"video":{"desc":"Video","ratio":1}}}`)
		case "/api/token/":
			created.Add(1)
			io.WriteString(w, `{"success":true,"data":{"key":"inference-secret"}}`)
		case "/v1/models":
			io.WriteString(w, `{"object":"list","data":[{"id":"test-video","supported_endpoint_types":["openai-video"]}]}`)
		default:
			t.Errorf("unexpected remote call: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	h, err := Open(context.Background(), bootstrap.Config{Profile: bootstrap.ProfileServer, DataDir: t.TempDir(), AutoMigrate: true, ShutdownTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	h.client = &client{origin: server.URL, http: server.Client()}
	t.Cleanup(func() {
		if err := h.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	request := func(method, path, body, session, cookie string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Aihubkit-Client", "1")
		r.Header.Set(sessionHeader, session)
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: cookieName, Value: cookie})
		}
		w := httptest.NewRecorder()
		h.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: status=%d body=%s", method, path, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "management-secret") || strings.Contains(w.Body.String(), "inference-secret") {
			t.Fatal("workspace response exposed remote credentials")
		}
		return w
	}
	login := func(username string) string {
		t.Helper()
		w := request("POST", apiPrefix+"login", `{"username":"`+username+`","password":"password"}`, "", "", 200)
		var envelope struct {
			Data struct {
				Session string `json:"session"`
				Scope   string `json:"scope"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || envelope.Data.Session == "" || envelope.Data.Scope == "" {
			t.Fatal("missing account session/scope")
		}
		return envelope.Data.Session
	}
	first := login("first")
	request("GET", "/api/workspace/bootstrap", "", first, "", 200)
	w := request("POST", "/api/projects", `{"name":"first account project"}`, first, "", 200)
	var project struct {
		Data struct {
			Project struct{ ID string } `json:"project"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &project); err != nil || project.Data.Project.ID == "" {
		t.Fatal("missing created project")
	}
	id := project.Data.Project.ID
	request("POST", "/api/projects", `{"name":"cookie only write"}`, "", first, 409)
	request("POST", apiPrefix+"logout", `{}`, first, "", 200)
	request("GET", "/api/projects/"+id, "", first, "", 401)
	second := login("second")
	request("GET", "/api/projects/"+id, "", second, "", 404)
	request("POST", "/api/projects", `{"name":"stale tab"}`, first, second, 401)
	request("POST", apiPrefix+"logout", `{}`, second, "", 200)
	again := login("first")
	if first == again {
		t.Fatal("logout did not rotate the local session")
	}
	request("GET", "/api/projects/"+id, "", again, "", 200)
	if created.Load() != 2 {
		t.Fatal("relogin recreated persisted group credentials")
	}
}
