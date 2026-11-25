package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestBusinessGatewayListsCallsAndBlocksPaidGeneration(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api")
	api.GET("/assets", func(c *gin.Context) {
		p, hasPrincipal := externalBusiness(c)
		ok(c, gin.H{"query": c.Query("q"), "authorized": hasPrincipal && !p.ReadOnly})
	})
	api.POST("/asset-folders", func(c *gin.Context) {
		var body struct {
			Name string `json:"name"`
		}
		_ = c.ShouldBindJSON(&body)
		ok(c, gin.H{"name": body.Name, "idem": c.GetHeader("X-Idempotency-Key")})
	})
	api.POST("/tasks", func(c *gin.Context) {
		t.Fatal("paid generation route must be blocked before reaching handler")
	})

	catalog := NewBusinessCatalog(r.Routes())
	gw := NewBusinessGateway(r, catalog)
	if gw == nil {
		t.Fatal("expected non-nil business gateway")
	}

	items, total := gw.ListBusinessTools("asset", "", false, 0, 10)
	if total < 2 || len(items) < 2 {
		t.Fatalf("expected asset tools in catalog, got total=%d items=%+v", total, items)
	}

	// GET call passes query and externalBusiness principal.
	res, err := gw.CallBusinessTool(context.Background(), "local", operations.BusinessCallRequest{
		Tool:  "business_get_assets",
		Query: map[string]string{"q": "hero"},
	})
	if err != nil {
		t.Fatalf("CallBusinessTool GET /assets: %v", err)
	}
	resMap := res.(map[string]any)
	dataMap := resMap["data"].(map[string]any)
	if dataMap["query"] != "hero" || dataMap["authorized"] != true {
		t.Fatalf("unexpected GET response: %+v", resMap)
	}

	// POST write forwards body and X-Idempotency-Key.
	writeRes, err := gw.CallBusinessTool(context.Background(), "local", operations.BusinessCallRequest{
		Tool:        "business_post_asset_folders",
		Body:        json.RawMessage(`{"name":"剧本资料"}`),
		OperationID: "op-folder-1",
	})
	if err != nil {
		t.Fatalf("CallBusinessTool POST /asset-folders: %v", err)
	}
	writeData := writeRes.(map[string]any)["data"].(map[string]any)
	if writeData["name"] != "剧本资料" || writeData["idem"] != "op-folder-1" {
		t.Fatalf("unexpected POST response: %+v", writeData)
	}

	// Paid generation route POST /tasks MUST be rejected.
	_, err = gw.CallBusinessTool(context.Background(), "local", operations.BusinessCallRequest{
		Tool: "business_post_tasks",
		Body: json.RawMessage(`{"type":"canvas_image","prompt":"cat"}`),
	})
	if err == nil {
		t.Fatal("expected POST /tasks to be blocked for built-in assistant")
	}
	opErr := operations.AsError(err)
	if opErr.Reason != "generation_approval_required" {
		t.Fatalf("expected generation_approval_required, got %+v", opErr)
	}

	// Invalid path traversal param rejected.
	_, err = gw.CallBusinessTool(context.Background(), "local", operations.BusinessCallRequest{
		Tool: "business_get_nonexistent",
	})
	if err == nil || operations.AsError(err).Reason != "business_tool_not_found" {
		t.Fatalf("expected business_tool_not_found, got %v", err)
	}
}

func TestBusinessGatewayBlocksPaidApprovalCanvasMutationsSSEAndCapsMemory(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api")
	for _, fn := range []func(){
		func() {
			api.POST("/timeline/transcriptions", func(c *gin.Context) { t.Fatal("transcription must be blocked") })
		},
		func() {
			api.POST("/creation-runs/:id/submissions/approve", func(c *gin.Context) { t.Fatal("approval must be blocked") })
		},
		func() {
			api.POST("/creation-runs/:id/proposal-approve", func(c *gin.Context) { t.Fatal("proposal approval must be blocked") })
		},
		func() {
			api.POST("/creation-runs/:id/canvas", func(c *gin.Context) { t.Fatal("creation canvas create must be blocked") })
		},
		func() {
			api.POST("/creation-runs/:id/canvas-commit", func(c *gin.Context) { t.Fatal("creation canvas commit must be blocked") })
		},
		func() {
			api.POST("/canvas-projects", func(c *gin.Context) { t.Fatal("canvas create must be blocked") })
		},
		func() {
			api.PUT("/canvas-projects/:id", func(c *gin.Context) { t.Fatal("canvas put must be blocked") })
		},
		func() {
			api.DELETE("/canvas-projects/:id", func(c *gin.Context) { t.Fatal("canvas delete must be blocked") })
		},
		func() {
			api.GET("/canvas-projects/:id/events", func(c *gin.Context) { t.Fatal("canvas sse must be blocked") })
		},
		func() {
			api.GET("/tasks/:id/text-events", func(c *gin.Context) { t.Fatal("task sse must be blocked") })
		},
	} {
		fn()
	}

	writeChunks := 0
	ctxCanceled := false
	api.GET("/projects", func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		chunk := []byte(strings.Repeat("a", 256*1024))
		for i := 0; i < 64; i++ {
			writeChunks++
			if _, err := c.Writer.Write(chunk); err != nil {
				ctxCanceled = c.Request.Context().Err() != nil
				return
			}
		}
	})

	catalog := NewBusinessCatalog(r.Routes())
	gw := NewBusinessGateway(r, catalog)

	blockedCases := []struct {
		tool   string
		path   map[string]string
		reason string
	}{
		{"business_post_timeline_transcriptions", nil, "generation_approval_required"},
		{"business_post_creation_runs_id_submissions_approve", map[string]string{"id": "run-1"}, "generation_approval_required"},
		{"business_post_creation_runs_id_proposal_approve", map[string]string{"id": "run-1"}, "generation_approval_required"},
		{"business_post_creation_runs_id_canvas", map[string]string{"id": "run-1"}, "use_canvas_operation"},
		{"business_post_creation_runs_id_canvas_commit", map[string]string{"id": "run-1"}, "use_canvas_operation"},
		{"business_post_canvas_projects", nil, "use_canvas_operation"},
		{"business_put_canvas_projects_id", map[string]string{"id": "c1"}, "use_canvas_operation"},
		{"business_delete_canvas_projects_id", map[string]string{"id": "c1"}, "use_canvas_operation"},
		{"business_get_canvas_projects_id_events", map[string]string{"id": "c1"}, "streaming_route_unsupported"},
		{"business_get_tasks_id_text_events", map[string]string{"id": "t1"}, "streaming_route_unsupported"},
	}
	for _, tc := range blockedCases {
		_, err := gw.CallBusinessTool(context.Background(), "local", operations.BusinessCallRequest{
			Tool: tc.tool,
			Path: tc.path,
		})
		if err == nil {
			t.Fatalf("%s should be blocked", tc.tool)
		}
		if got := operations.AsError(err); got.Reason != tc.reason {
			t.Fatalf("%s expected reason %s, got %+v", tc.tool, tc.reason, got)
		}
	}

	// Oversized response must abort early at the 4 MiB boundary without buffering all 16 MiB.
	_, err := gw.CallBusinessTool(context.Background(), "local", operations.BusinessCallRequest{
		Tool: "business_get_projects",
	})
	if err == nil || operations.AsError(err).Reason != "business_response_too_large" {
		t.Fatalf("expected business_response_too_large, got %v", err)
	}
	if writeChunks >= 64 || !ctxCanceled {
		t.Fatalf("expected bounded writer to abort early & cancel ctx, chunks=%d canceled=%v", writeChunks, ctxCanceled)
	}
}

type fakeAssistantRefService struct{}

func (fakeAssistantRefService) CanvasService() *canvas.Service { return nil }
func (fakeAssistantRefService) Resource(userID, id string) (*model.Resource, error) {
	return &model.Resource{ID: id, UserID: userID, Kind: "file", Status: model.ResourceStatusReady}, nil
}

func TestNormalizeAssistantReferencesDeduplicatesSixteenFiles(t *testing.T) {
	// Simulates frontend sending 16 file references + server appending 16 matching attachment references (32 raw entries).
	items := make([]assistantReference, 0, 32)
	for i := 1; i <= 16; i++ {
		ref := assistantReference{Kind: "resource", ID: fmt.Sprintf("res-%02d", i)}
		items = append(items, ref, ref)
	}
	got, err := normalizeAssistantReferences(fakeAssistantRefService{}, "u1", items)
	if err != nil {
		t.Fatalf("expected 16 deduplicated file references to succeed, got %v", err)
	}
	if len(got) != 16 {
		t.Fatalf("expected 16 unique references, got %d", len(got))
	}

	// 17 distinct resources must still be rejected.
	items = append(items, assistantReference{Kind: "resource", ID: "res-17"})
	if _, err := normalizeAssistantReferences(fakeAssistantRefService{}, "u1", items); err == nil {
		t.Fatal("expected 17 distinct references to be rejected")
	}
	_ = http.StatusOK
}
