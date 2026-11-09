package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Run this binary in the final Docker image as app to verify its actual tools,
// persistent queue and owned output, without an assistant or external model.
func TestTimelineBackgroundRenderSurvivesObserverClose(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	if out, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=1.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source).CombinedOutput(); err != nil {
		t.Fatalf("source: %v %s", err, out)
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "workspace.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), dir)
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	const canvasID = "timeline-export-canvas"
	if _, err := svc.UpsertUserCanvasProject(owner.ID, []byte(`{"id":"timeline-export-canvas","title":"Export","revision":0,"nodes":[],"connections":[]}`)); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	stat, err := file.Stat()
	if err != nil {
		file.Close()
		t.Fatal(err)
	}
	resource, err := svc.UploadLocalResourceFile(owner.ID, "source.mp4", stat.Size(), "video", 320, 240, 1500, file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	deps := defaultRuntimeDependencies(svc)
	deps.DesktopTrust = func(*http.Request) bool { return true }
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: dir}), RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), svc)
	server := httptest.NewServer(router)
	defer server.Close()
	options := editing.DefaultOptions()
	options.Width, options.Height, options.FPS = 320, 240, 24
	timeline := editing.Project{Version: 2, DurationMs: 1500, Output: &options,
		Tracks: []editing.Track{{ID: "video", Kind: "video"}, {ID: "sub", Kind: "subtitle"}},
		Clips: []editing.Clip{
			{ID: "video", NodeID: "source", TrackID: "video", Kind: "video", DurationMs: 1500, Volume: 1, DirectMedia: &editing.DirectMedia{ID: "source", Kind: "video", StorageKey: "resource:" + resource.ID}},
			{ID: "sub", TrackID: "sub", Kind: "subtitle", StartMs: 100, DurationMs: 1000, Text: "中文字幕"},
		}}
	body, err := json.Marshal(app.TimelineRenderCreateRequest{ProjectID: canvasID, Timeline: timeline, ClientOperationID: "background-render"})
	if err != nil {
		t.Fatal(err)
	}
	requestCtx, detach := context.WithCancel(ctx)
	defer detach()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, server.URL+"/api/timeline/renders", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var admitted struct {
		Data   model.Task `json:"data"`
		Msg    string     `json:"msg"`
		Reason string     `json:"reason"`
	}
	decodeErr := json.NewDecoder(response.Body).Decode(&admitted)
	response.Body.Close()
	detach()
	server.Client().CloseIdleConnections()
	if decodeErr != nil || response.StatusCode != http.StatusOK || admitted.Data.ID == "" || admitted.Data.ProjectID != canvasID {
		t.Fatalf("admission: status=%d task=%+v err=%v", response.StatusCode, admitted, decodeErr)
	}
	// Start execution only after the submitting UI has disconnected.
	svc.StartWorker()
	t.Cleanup(func() {
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = svc.StopWorker(stopCtx)
	})
	var completed model.Task
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	for ctx.Err() == nil {
		reply, err := client.Get(server.URL + "/api/tasks/" + admitted.Data.ID)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Data model.Task `json:"data"`
		}
		err = json.NewDecoder(reply.Body).Decode(&envelope)
		reply.Body.Close()
		if err != nil || reply.StatusCode != http.StatusOK {
			t.Fatalf("query: status=%d err=%v", reply.StatusCode, err)
		}
		completed = envelope.Data
		if completed.Status == "succeeded" || completed.Status == "failed" || completed.Status == "cancelled" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if completed.Status != "succeeded" {
		t.Fatalf("background render: %+v", completed)
	}
	var result struct {
		ResourceID string `json:"resourceId"`
	}
	if err := json.Unmarshal([]byte(completed.ResultJSON), &result); err != nil || result.ResourceID == "" {
		t.Fatalf("result: %s %v", completed.ResultJSON, err)
	}
	meta, reader, err := svc.OpenResource(owner.ID, result.ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || meta.Status != "ready" || meta.Kind != "video" || len(data) == 0 {
		t.Fatalf("owned output: %+v bytes=%d err=%v", meta, len(data), err)
	}
	output := filepath.Join(dir, "result.mp4")
	if err := os.WriteFile(output, data, 0600); err != nil {
		t.Fatal(err)
	}
	probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", output).CombinedOutput()
	if err != nil || !strings.Contains(string(probe), "video") || !strings.Contains(string(probe), "audio") {
		t.Fatalf("output streams: %s %v", probe, err)
	}
	pixels, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-ss", "0.5", "-i", output, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range pixels {
		if value > 200 { // White subtitle glyphs on the blue source.
			return
		}
	}
	t.Fatal("rendered frame has no subtitle glyphs")
}
