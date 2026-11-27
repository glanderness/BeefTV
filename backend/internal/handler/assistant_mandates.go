package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func rejectAgentTokenForApproval(c *gin.Context, svc ownerCredentialDirs) bool {
	if strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" || isAssistantHostRequest(c, svc) {
		c.JSON(http.StatusForbidden, gin.H{
			"code":   http.StatusForbidden,
			"reason": "agent_token_cannot_approve",
			"msg":    "Agent 或宿主凭据不能自批预算包或工具审批，请在 BeefTV 界面或使用工作区 owner 凭据确认",
		})
		return true
	}
	return false
}

func dispatchApprovalSignalToHost(
	ctx context.Context,
	host *assistantruntime.Host,
	rec *operations.ToolApprovalRecord,
	decision, mandateID, reason string,
) bool {
	if host == nil || rec == nil || rec.DurableTaskID <= 0 {
		return false
	}
	if strings.TrimSpace(rec.CanvasID) == "" || strings.TrimSpace(rec.SessionID) == "" {
		return false
	}
	if !host.HasSignalEndpoint() {
		return false
	}
	payload, err := json.Marshal(map[string]any{
		"canvasId":      strings.TrimSpace(rec.CanvasID),
		"sessionId":     strings.TrimSpace(rec.SessionID),
		"durableTaskId": rec.DurableTaskID,
		"signal":        "approval_decision",
		"key":           strings.TrimSpace(rec.ProposalID),
		"value": map[string]any{
			"decision":   decision,
			"proposalId": strings.TrimSpace(rec.ProposalID),
			"mandateId":  strings.TrimSpace(mandateID),
			"reason":     strings.TrimSpace(reason),
		},
	})
	if err != nil {
		return false
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := host.NewChildRequest(reqCtx, http.MethodPost, "/signals", bytes.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := host.HTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func registerAssistantMandateRoutes(
	r gin.IRouter,
	svc agentProxyService,
	host *assistantruntime.Host,
	guard func(*gin.Context, bool) bool,
	requireOwnedCanvas func(*gin.Context, string) (json.RawMessage, bool),
) {
	r.GET("/assistant/mandates", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		if canvasID != "" {
			if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
				return
			}
		}
		sessionID := strings.TrimSpace(c.Query("sessionId"))
		status := strings.TrimSpace(c.Query("status"))
		mandates, err := operations.ListProductionMandatesInTx(svc.Database(), c.GetString("agentUserId"), canvasID, sessionID, status)
		if err != nil {
			failAssistantProposal(c, err)
			return
		}
		ok(c, gin.H{"mandates": mandates})
	})

	r.POST("/assistant/mandates", func(c *gin.Context) {
		if rejectAgentTokenForApproval(c, svc) {
			return
		}
		if !guard(c, true) {
			return
		}
		_, payload, valid := readAssistantBody(c, struct {
			CanvasID         string   `json:"canvasId"`
			SessionID        string   `json:"sessionId"`
			MaxAmountCNY     float64  `json:"maxAmountCny"`
			MaxUnquotedCount int      `json:"maxUnquotedCount"`
			AllowedKinds     []string `json:"allowedKinds"`
			ExpiresInMinutes int      `json:"expiresInMinutes"`
			ProposalID       string   `json:"proposalId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		userID := c.GetString("agentUserId")
		approvedBy := "ui"
		if identity := strings.TrimSpace(c.GetString("agentIdentity")); identity == "owner" {
			approvedBy = "owner-cli"
		}
		var created *model.AssistantProductionMandate
		var wokeApproval *operations.ToolApprovalRecord
		err := svc.Database().Transaction(func(tx *gorm.DB) error {
			in := operations.CreateProductionMandateInput{
				CanvasID:         strings.TrimSpace(payload.CanvasID),
				SessionID:        strings.TrimSpace(payload.SessionID),
				MaxAmountCNY:     payload.MaxAmountCNY,
				MaxUnquotedCount: payload.MaxUnquotedCount,
				AllowedKinds:     payload.AllowedKinds,
				ExpiresInMinutes: payload.ExpiresInMinutes,
				ApprovedBy:       approvedBy,
			}
			if propID := strings.TrimSpace(payload.ProposalID); propID != "" {
				if !assistantProposalIDPattern.MatchString(propID) {
					return operations.InvalidArg("invalid_proposal_id", "审批标识无效")
				}
				rec, m, decErr := operations.DecideToolApprovalInTx(tx, userID, propID, "approve", approvedBy, "", &in)
				if decErr != nil {
					return decErr
				}
				wokeApproval = rec
				created = m
				return nil
			}
			m, createErr := operations.CreateProductionMandateInTx(tx, userID, in)
			if createErr != nil {
				return createErr
			}
			created = m
			return nil
		})
		if err != nil {
			failAssistantProposal(c, err)
			return
		}
		signaled := false
		if wokeApproval != nil {
			signaled = dispatchApprovalSignalToHost(c.Request.Context(), host, wokeApproval, "approve", created.ID, "")
		}
		resp := gin.H{
			"mandate":  operations.ProjectProductionMandate(*created),
			"signaled": signaled,
		}
		if wokeApproval != nil {
			resp["approval"] = wokeApproval
		}
		ok(c, resp)
	})

	r.POST("/assistant/mandates/:id/revoke", func(c *gin.Context) {
		if rejectAgentTokenForApproval(c, svc) {
			return
		}
		if !guard(c, true) {
			return
		}
		mandateID := strings.TrimSpace(c.Param("id"))
		if mandateID == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("预算包 ID 必填"))
			return
		}
		var revoked *model.AssistantProductionMandate
		err := svc.Database().Transaction(func(tx *gorm.DB) error {
			m, revErr := operations.RevokeProductionMandateInTx(tx, c.GetString("agentUserId"), mandateID)
			if revErr != nil {
				return revErr
			}
			revoked = m
			return nil
		})
		if err != nil {
			failAssistantProposal(c, err)
			return
		}
		ok(c, gin.H{"mandate": operations.ProjectProductionMandate(*revoked)})
	})

	r.GET("/assistant/approvals", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		if canvasID != "" {
			if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
				return
			}
		}
		sessionID := strings.TrimSpace(c.Query("sessionId"))
		approvals, err := operations.ListPendingToolApprovalsInTx(svc.Database(), c.GetString("agentUserId"), canvasID, sessionID)
		if err != nil {
			failAssistantProposal(c, err)
			return
		}
		ok(c, gin.H{"approvals": approvals})
	})

	r.POST("/assistant/approvals/:proposalId/decide", func(c *gin.Context) {
		if rejectAgentTokenForApproval(c, svc) {
			return
		}
		if !guard(c, true) {
			return
		}
		proposalID := strings.TrimSpace(c.Param("proposalId"))
		if !assistantProposalIDPattern.MatchString(proposalID) {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("审批标识无效"))
			return
		}
		_, payload, valid := readAssistantBody(c, struct {
			CanvasID      string                                   `json:"canvasId"`
			Decision      string                                   `json:"decision"`
			Reason        string                                   `json:"reason"`
			CreateMandate *operations.CreateProductionMandateInput `json:"createMandate"`
		}{})
		if !valid {
			return
		}
		if strings.TrimSpace(payload.CanvasID) != "" {
			if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
				return
			}
		}
		approvedBy := "ui"
		if identity := strings.TrimSpace(c.GetString("agentIdentity")); identity == "owner" {
			approvedBy = "owner-cli"
		}
		var decided *operations.ToolApprovalRecord
		var createdMandate *model.AssistantProductionMandate
		err := svc.Database().Transaction(func(tx *gorm.DB) error {
			rec, m, decErr := operations.DecideToolApprovalInTx(
				tx,
				c.GetString("agentUserId"),
				proposalID,
				payload.Decision,
				approvedBy,
				payload.Reason,
				payload.CreateMandate,
			)
			if decErr != nil {
				return decErr
			}
			decided = rec
			createdMandate = m
			return nil
		})
		if err != nil {
			failAssistantProposal(c, err)
			return
		}
		mandateID := decided.MandateID
		if createdMandate != nil {
			mandateID = createdMandate.ID
		}
		signaled := dispatchApprovalSignalToHost(c.Request.Context(), host, decided, decided.Decision, mandateID, decided.RejectReason)
		resp := gin.H{
			"approval": decided,
			"signaled": signaled,
		}
		if createdMandate != nil {
			resp["mandate"] = operations.ProjectProductionMandate(*createdMandate)
		}
		ok(c, resp)
	})
}
