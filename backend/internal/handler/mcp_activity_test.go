package handler

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/operations"
)

func TestMCPActivityTransportAndGenerationResult(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	req := httptest.NewRequest("POST", "/api/ops/canvas.generation.submit", nil)
	tool := BusinessTool{ID: "canvas.generation.submit", SubmitsGeneration: true}
	c.Request = WithMCPClient(req, "claude", tool)
	if activityFor(c) != nil {
		t.Fatal("ordinary CLI request recorded")
	}
	req.Header.Set("X-BeefTV-MCP", "1")
	c.Request = WithMCPClient(req, "claude", tool)
	captureMCPResult(c, operations.Result{Result: map[string]any{"taskIds": []any{"t1", "t2"}}})
	event := activityFor(c)
	if event.call.Client != "claude" || len(event.taskIDs) != 2 || event.taskIDs[1] != "t2" {
		t.Fatalf("generation event %+v", event)
	}
	c.Request = WithMCPClient(req, "claude", tool)
	captureMCPResult(c, operations.Result{Replayed: true, Result: map[string]any{"taskIds": []any{"old"}}})
	if event = activityFor(c); event.call.Billing != "replay" || len(event.taskIDs) != 0 {
		t.Fatalf("replay billed %+v", event)
	}
	c.Request = WithMCPClient(req, "claude", BusinessTool{ID: "media.review", SubmitsGeneration: true})
	captureMCPResult(c, operations.Result{Result: map[string]any{"review": map[string]any{"model": "review-model", "observations": "private"}}})
	if event = activityFor(c); event.call.ModelName != "review-model" || event.call.Billing != "unknown" {
		t.Fatalf("review %+v", event)
	}
}
