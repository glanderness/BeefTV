package handler

import (
	"context"
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	"log"
	"net/http"
	"time"
)

type mcpActivityKey struct{}
type mcpActivity struct {
	call    model.MCPCall
	taskIDs []string
}

// WithMCPClient is used only after credential verification. The transport marker
// distinguishes a tool invocation from discovery, CLI calls and desktop traffic.
func WithMCPClient(r *http.Request, client string, tool BusinessTool) *http.Request {
	if r.Header.Get("X-BeefTV-MCP") != "1" {
		return r
	}
	event := &mcpActivity{call: model.MCPCall{Client: client, CreatedAt: time.Now().UTC(), Tool: tool.ID, Billing: "none"}}
	if tool.SubmitsGeneration || tool.ID == "business_post_timeline_transcriptions" {
		event.call.Billing = "unknown"
	}
	if r.URL.Path == "/api/business/tools" {
		event.call.Tool = "business.list"
	}
	return r.WithContext(context.WithValue(r.Context(), mcpActivityKey{}, event))
}

func activityFor(c *gin.Context) *mcpActivity {
	event, _ := c.Request.Context().Value(mcpActivityKey{}).(*mcpActivity)
	return event
}

func MCPActivityRecorder(repo *repository.Repository, userID string, quotaPerYuan func() int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		event := activityFor(c)
		c.Next()
		if event == nil || event.call.Tool == "" {
			return
		}
		event.call.UserID = userID
		event.call.CreatedAt = time.Now().UTC()
		if len(event.taskIDs) > 0 {
			event.call.QuotaPerYuan = quotaPerYuan()
		}
		event.call.Failed = c.Writer.Status() >= 400
		if err := repo.RecordMCPCall(&event.call, event.taskIDs); err != nil {
			log.Printf("record MCP call: %v", err)
		}
	}
}

func captureMCPResult(c *gin.Context, data any) {
	event := activityFor(c)
	if event == nil || event.call.Billing != "unknown" {
		return
	}
	switch value := data.(type) {
	case *model.Task:
		if value != nil {
			event.taskIDs = []string{value.ID}
		}
	case operations.Result:
		if value.Replayed {
			event.call.Billing = "replay"
			return
		}
		result, _ := value.Result.(map[string]any)
		if result["status"] == "pending_approval" {
			event.call.Billing = "none"
			return
		}
		if review, ok := result["review"].(map[string]any); ok {
			event.call.ModelName, _ = review["model"].(string)
		}
		ids, _ := result["taskIds"].([]any)
		for _, v := range ids {
			if id, ok := v.(string); ok {
				event.taskIDs = append(event.taskIDs, id)
			}
		}
	}
}

func RegisterMCPActivity(api *gin.RouterGroup, repo *repository.Repository, userID string, svc ownerCredentialDirs, trust func(*http.Request) bool) {
	api.GET("/agent-clients/activity", func(c *gin.Context) {
		if !requireDesktopUITrust(c, svc, trust) {
			return
		}
		rows, err := repo.RecentMCPCalls(userID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, rows)
	})
}
