package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestLocalRunningHubMetadataRequiresActivationAndDoesNotGenerate(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/openapi/getJsonApiFormat":
			_, _ = w.Write([]byte(`{"code":0,"data":{"prompt":{"3":{"class_type":"CLIPTextEncode","inputs":{"text":"hello"}}}}}`))
		case "/api/webapp/apiCallDemo":
			var request map[string]any
			_ = json.NewDecoder(r.Body).Decode(&request)
			if request["webappId"] == "malformed" {
				_, _ = w.Write([]byte(`{"code":0}`))
				return
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"nodeInfoList":[]}}`))
		default:
			t.Errorf("metadata query called generation endpoint: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "runninghub.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	svc := app.NewLocal(repository.New(db), dir)
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: dir}))
	RegisterDesktopCanvasAPI(router.Group("/api"), svc)
	query := func(path, id string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"baseUrl": upstream.URL, "apiKey": "test-key", "workflowId": id, "webappId": id, "capability": "image"})
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	for _, path := range []string{"/api/runninghub/workflow-info", "/api/runninghub/app-info"} {
		response := query(path, "demo")
		if response.Code < 400 || upstreamCalls != 0 {
			t.Fatalf("disabled plugin accepted: status=%d calls=%d", response.Code, upstreamCalls)
		}
	}
	if _, err := svc.SetUserPluginEnabled(owner, app.WorkflowPluginRunningHub, true); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/runninghub/workflow-info", "/api/runninghub/app-info"} {
		response := query(path, "demo")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"code":0`) {
			t.Fatalf("metadata request failed: status=%d body=%s", response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), `"raw"`) || strings.Contains(response.Body.String(), "test-key") {
			t.Fatal("metadata exposed raw upstream response or credential")
		}
	}
	if response := query("/api/runninghub/app-info", "malformed"); response.Code < 400 {
		t.Fatal("malformed App metadata was accepted")
	}
	if _, err := svc.SetUserPluginEnabled(owner, app.WorkflowPluginRunningHub, false); err != nil {
		t.Fatal(err)
	}
	before := upstreamCalls
	if response := query("/api/runninghub/workflow-info", "demo"); response.Code < 400 || upstreamCalls != before {
		t.Fatal("disabled plugin still queried upstream")
	}
}
