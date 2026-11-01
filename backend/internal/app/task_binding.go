package app

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/gorm"
)

const canvasBindRecoveryBatch = 64

func (s *Service) workspaceOperations() *operations.Registry {
	if s == nil || s.repo == nil {
		return nil
	}
	s.workspaceOpsMu.Lock()
	defer s.workspaceOpsMu.Unlock()
	if s.workspaceOps != nil {
		return s.workspaceOps
	}
	db := s.Database()
	if db == nil {
		return nil
	}
	registry := operations.NewRegistry(s, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	s.workspaceOps = registry
	return registry
}

func (s *Service) recoverCanvasTaskBindings(task model.Task) error {
	if s == nil || strings.TrimSpace(task.ID) == "" || strings.TrimSpace(task.UserID) == "" || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	intents := s.CanvasBindingIntents(task)
	canvasIDs, missing, err := localtask.TaskCanvasState(task, intents, s.isOwnedBusinessProject(task.UserID), s.canvasExists(task.UserID))
	if err != nil {
		return err
	}
	var last error
	if missing {
		if localtask.HasCanvasBindMarker(task.RecoveryOutcome) {
			last = s.repo.UpdateCanvasBindRecovery(task.UserID, task.ID, nil)
		}
	} else {
		if len(canvasIDs) > 0 {
			if err := s.prepareSeedreamOutputNodes(task); err != nil {
				return err
			}
		}
		if err := s.RegisterTaskOutputFromTask(task); err != nil {
			last = err
		} else if localtask.HasWorkflowOutputIntent(task.InputJSON) {
			_ = s.generationDeliverer().Deliver(task)
			intents = s.CanvasBindingIntents(task)
		}
		if len(canvasIDs) > 0 {
			if registry := s.workspaceOperations(); registry != nil {
				pass := localtask.NewCanvasBindPass(task.RecoveryOutcome)
				for _, target := range localtask.CanvasBindTargets(task, intents) {
					if pass.Skip(target.NodeID, target.OutputIndex, s.canvasRevision(task)) {
						continue
					}
					if err := s.executeCanvasTaskBind(registry, task, target.NodeID, target.OutputIndex); err != nil {
						if reason, details := canvasBindRefusal(err); pass.Refused(target.NodeID, target.OutputIndex, reason, details) || skippableCanvasBindError(err) {
							continue
						}
						last = err
						continue
					}
					pass.Bound(target.NodeID, target.OutputIndex)
				}
				if marker, changed, err := pass.Finish(); err != nil {
					last = err
				} else if changed {
					if err := s.repo.UpdateCanvasBindRecovery(task.UserID, task.ID, marker); err != nil {
						last = err
					}
				}
			}
		}
	}
	if registry := s.workspaceOperations(); registry != nil {
		for _, target := range localtask.MessageBindTargets(task, intents) {
			if err := s.executeMessageTaskAttach(registry, task, target.ConversationID, target.MessageID, target.OutputIndex); err != nil {
				last = err
			}
		}
	}
	if projectID := strings.TrimSpace(task.ProjectID); projectID != "" {
		s.reconcileCharacterTurnaroundTasks(task.UserID, projectID)
	}
	return last
}

func (s *Service) recoverPendingCanvasBindings(limit int) error {
	if s == nil || s.repo == nil {
		return nil
	}
	if s.workspaceOperations() == nil {
		return nil
	}
	if limit <= 0 {
		limit = canvasBindRecoveryBatch
	}
	s.bindCursorMu.Lock()
	afterID := s.bindAfterID
	s.bindCursorMu.Unlock()
	tasks, err := s.repo.SucceededTasksForDelivery(afterID, limit)
	if err != nil {
		if bindInfrastructureUnavailable(err) {
			return nil
		}
		return err
	}
	if len(tasks) == 0 && afterID != "" {
		tasks, err = s.repo.SucceededTasksForDelivery("", limit)
		if err != nil {
			if bindInfrastructureUnavailable(err) {
				return nil
			}
			return err
		}
	}
	s.bindCursorMu.Lock()
	if len(tasks) == 0 || len(tasks) < limit {
		s.bindAfterID = ""
	} else {
		s.bindAfterID = tasks[len(tasks)-1].ID
	}
	s.bindCursorMu.Unlock()
	var last error
	for _, task := range tasks {
		if err := s.recoverCanvasTaskBindings(task); err != nil {
			last = err
		}
	}
	return last
}

func (s *Service) executeMessageTaskAttach(registry *operations.Registry, task model.Task, conversationID, messageID string, outputIndex int) error {
	conversationID = strings.TrimSpace(conversationID)
	messageID = strings.TrimSpace(messageID)
	if registry == nil || conversationID == "" || messageID == "" {
		return nil
	}
	params, err := json.Marshal(map[string]any{
		"conversationId": conversationID,
		"taskId":         task.ID,
		"messageId":      messageID,
		"outputIndex":    outputIndex,
	})
	if err != nil {
		return err
	}
	_, err = registry.Execute(operations.Request{
		Op:     "conversation.message.attach",
		OpID:   localtask.AttachMessageEffectKey(task.ID, messageID, outputIndex),
		UserID: task.UserID,
		Caller: operations.ManualCaller(false),
		Params: params,
	})
	if skippableCanvasBindError(err) {
		return nil
	}
	return err
}

func (s *Service) executeCanvasTaskBind(registry *operations.Registry, task model.Task, nodeID string, outputIndex int) error {
	canvasID := strings.TrimSpace(task.ProjectID)
	nodeID = strings.TrimSpace(nodeID)
	if registry == nil || canvasID == "" || nodeID == "" {
		return nil
	}
	params, err := json.Marshal(map[string]any{
		"canvasId":    canvasID,
		"taskId":      task.ID,
		"nodeId":      nodeID,
		"outputIndex": outputIndex,
	})
	if err != nil {
		return err
	}
	_, err = registry.Execute(operations.Request{
		Op:     "canvas.task.bind",
		OpID:   localtask.AttachNodeEffectKey(task.ID, nodeID, outputIndex),
		UserID: task.UserID,
		Caller: operations.ManualCaller(false),
		Params: params,
	})
	return err
}

func skippableCanvasBindError(err error) bool {
	if err == nil {
		return true
	}
	if bindInfrastructureUnavailable(err) {
		return true
	}
	reason, _ := canvasBindRefusal(err)
	if reason == "" {
		return false
	}
	switch reason {
	case "node_deleted", "node_task_mismatch", "node_mismatch", "canvas_mismatch",
		"conversation_deleted", "message_deleted", "message_mismatch", "conversation_mismatch",
		"message_task_mismatch",
		"task_not_found", "task_not_succeeded", "task_foreign",
		"output_not_ready", "resource_not_ready", "resource_missing", "resource_foreign",
		"resource_mismatch", "asset_foreign", "delivery_unreadable", "unsupported_result_shape",
		"effect_identity_mismatch":
		return true
	default:
		return false
	}
}

// canvasRevision reads the task canvas's current revision on demand, so the
// scan only touches canvas metadata for targets that carry a refusal marker.
func (s *Service) canvasRevision(task model.Task) func() (int64, error) {
	return func() (int64, error) {
		current, err := s.repo.CanvasProjectMetadata(task.UserID, task.ProjectID)
		return current.Revision, err
	}
}

func (s *Service) canvasExists(userID string) func(string) (bool, error) {
	return func(canvasID string) (bool, error) {
		_, err := s.repo.CanvasProjectMetadata(userID, canvasID)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, gorm.ErrRecordNotFound) || bindInfrastructureUnavailable(err) {
			return false, nil
		}
		return false, err
	}
}

func (s *Service) isOwnedBusinessProject(userID string) func(string) (bool, error) {
	return func(projectID string) (bool, error) {
		_, err := s.repo.ProjectForUser(userID, projectID)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, gorm.ErrRecordNotFound) || bindInfrastructureUnavailable(err) {
			return false, nil
		}
		return false, err
	}
}

// canvasBindRefusal reads the reason and details of a bind operation error.
func canvasBindRefusal(err error) (string, map[string]any) {
	var opErr *operations.Error
	if err == nil || !errors.As(err, &opErr) {
		return "", nil
	}
	return opErr.Reason, opErr.Details
}

func bindInfrastructureUnavailable(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table") ||
		strings.Contains(message, "op_store_unavailable") ||
		strings.Contains(message, "op_domain_unavailable")
}
