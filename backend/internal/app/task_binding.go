package app

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
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
	if s == nil || strings.TrimSpace(task.ID) == "" || strings.TrimSpace(task.UserID) == "" {
		return nil
	}
	if task.Status != model.TaskStatusSucceeded {
		return nil
	}
	if err := s.prepareSeedreamOutputNodes(task); err != nil {
		return err
	}
	registry := s.workspaceOperations()
	intents := s.CanvasBindingIntents(task)
	bindRecovery, _ := localtask.DecodeCanvasBindRecovery(task.RecoveryOutcome)
	bindRecoveryDirty := false
	var last error
	if registry != nil {
		for _, target := range canvasBindTargets(task, intents) {
			if marker, ok := bindRecovery.Target(target.nodeID, target.outputIndex); ok {
				unchanged, stateErr := s.canvasBindTargetUnchanged(task, marker)
				if stateErr == nil && unchanged {
					continue
				}
				if stateErr == nil && bindRecovery.Remove(target.nodeID, target.outputIndex) {
					bindRecoveryDirty = true
				}
			}
			if err := s.executeCanvasTaskBind(registry, task, target.nodeID, target.outputIndex); err != nil {
				if terminalCanvasBindError(err) {
					if marker, ok := canvasBindRecoveryTarget(target, err); ok {
						bindRecovery.Upsert(marker)
						bindRecoveryDirty = true
					}
					continue
				}
				if skippableCanvasBindError(err) {
					continue
				}
				last = err
				continue
			}
			if bindRecovery.Remove(target.nodeID, target.outputIndex) {
				bindRecoveryDirty = true
			}
		}
		for _, target := range messageBindTargets(task, intents) {
			if err := s.executeMessageTaskAttach(registry, task, target.conversationID, target.messageID, target.outputIndex); err != nil {
				if skippableCanvasBindError(err) {
					continue
				}
				last = err
			}
		}
	}
	if bindRecoveryDirty {
		var outcome *string
		if !bindRecovery.Empty() {
			encoded, err := localtask.EncodeCanvasBindRecovery(bindRecovery)
			if err != nil {
				last = err
			} else {
				outcome = encoded
			}
		}
		if outcome != nil || bindRecovery.Empty() {
			if err := s.repo.UpdateTaskRecoveryOutcome(task.UserID, task.ID, outcome); err != nil {
				last = err
			}
		}
	}
	if err := s.RegisterTaskOutputFromTask(task); err != nil {
		last = err
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

type canvasBindTargetState struct {
	present           bool
	taskID            string
	nodeType          string
	clientOperationID string
	status            string
	hasMedia          bool
}

func (s *Service) canvasBindTargetUnchanged(task model.Task, marker localtask.CanvasBindRecoveryTarget) (bool, error) {
	if marker.Reason != "node_deleted" && marker.Reason != "node_task_mismatch" {
		return true, nil
	}
	current, err := s.canvasBindTargetState(task.UserID, task.ProjectID, marker.NodeID)
	if err != nil {
		return false, err
	}
	return current.present == marker.NodePresent &&
		current.taskID == strings.TrimSpace(marker.NodeTaskID) &&
		current.nodeType == strings.TrimSpace(marker.NodeType) &&
		current.clientOperationID == strings.TrimSpace(marker.NodeClientOperationID) &&
		current.status == strings.TrimSpace(marker.NodeStatus) &&
		current.hasMedia == marker.NodeHasMedia, nil
}

func (s *Service) canvasBindTargetState(userID, canvasID, nodeID string) (canvasBindTargetState, error) {
	raw, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return canvasBindTargetState{}, err
	}
	var doc struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return canvasBindTargetState{}, err
	}
	for _, node := range doc.Nodes {
		if strings.TrimSpace(canvasBindStateString(node, "id")) != strings.TrimSpace(nodeID) {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		return canvasBindTargetState{
			present:           true,
			taskID:            canvasBindStateString(metadata, "taskId"),
			nodeType:          canvasBindStateString(node, "type"),
			clientOperationID: canvasBindStateString(metadata, "taskClientOperationId"),
			status:            canvasBindStateString(metadata, "status"),
			hasMedia:          canvas.NodeHasMedia(node),
		}, nil
	}
	return canvasBindTargetState{}, nil
}

func canvasBindStateString(fields map[string]any, key string) string {
	if fields == nil {
		return ""
	}
	value, _ := fields[key].(string)
	return strings.TrimSpace(value)
}

func canvasBindRecoveryTarget(target canvasBindTarget, err error) (localtask.CanvasBindRecoveryTarget, bool) {
	reason := canvasBindErrorReason(err)
	if reason == "" || !terminalCanvasBindError(err) {
		return localtask.CanvasBindRecoveryTarget{}, false
	}
	marker := localtask.CanvasBindRecoveryTarget{NodeID: target.nodeID, OutputIndex: target.outputIndex, Reason: reason}
	switch reason {
	case "node_deleted":
		// The failed bind transaction observed no node. Do not read the canvas
		// again here: a concurrent recreation must make the marker stale.
		marker.NodePresent = false
		return marker, true
	case "node_task_mismatch":
		state, ok := canvasBindFailureState(err)
		if !ok {
			return localtask.CanvasBindRecoveryTarget{}, false
		}
		marker.NodePresent = state.present
		marker.NodeTaskID = state.taskID
		marker.NodeType = state.nodeType
		marker.NodeClientOperationID = state.clientOperationID
		marker.NodeStatus = state.status
		marker.NodeHasMedia = state.hasMedia
		return marker, true
	default:
		return marker, true
	}
}

func canvasBindFailureState(err error) (canvasBindTargetState, bool) {
	var opErr *operations.Error
	if !errors.As(err, &opErr) || opErr.Details == nil {
		return canvasBindTargetState{}, false
	}
	binding, ok := opErr.Details["canvasBinding"].(map[string]any)
	if !ok {
		return canvasBindTargetState{}, false
	}
	present, ok := binding["nodePresent"].(bool)
	if !ok {
		return canvasBindTargetState{}, false
	}
	return canvasBindTargetState{
		present:           present,
		taskID:            canvasBindStateString(binding, "nodeTaskId"),
		nodeType:          canvasBindStateString(binding, "nodeType"),
		clientOperationID: canvasBindStateString(binding, "nodeClientOperationId"),
		status:            canvasBindStateString(binding, "nodeStatus"),
		hasMedia:          canvasBindBool(binding, "nodeHasMedia"),
	}, true
}

func canvasBindBool(fields map[string]any, key string) bool {
	value, _ := fields[key].(bool)
	return value
}

func terminalCanvasBindError(err error) bool {
	switch canvasBindErrorReason(err) {
	case "node_deleted", "node_task_mismatch", "node_mismatch", "canvas_mismatch":
		return true
	default:
		return false
	}
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

type canvasBindTarget struct {
	nodeID      string
	outputIndex int
}

type messageBindTarget struct {
	conversationID string
	messageID      string
	outputIndex    int
}

func canvasBindTargets(task model.Task, intents []localtask.CanvasBindingIntent) []canvasBindTarget {
	seen := map[string]bool{}
	targets := make([]canvasBindTarget, 0, len(intents)+1)
	add := func(nodeID string, outputIndex int) {
		nodeID = strings.TrimSpace(nodeID)
		if nodeID == "" {
			return
		}
		key := nodeID + ":" + strconv.Itoa(outputIndex)
		if seen[key] {
			return
		}
		seen[key] = true
		targets = append(targets, canvasBindTarget{nodeID: nodeID, outputIndex: outputIndex})
	}
	for _, intent := range intents {
		if intent.TargetBinding == nil {
			continue
		}
		add(intent.TargetBinding.NodeID, intent.OutputIndex)
	}
	switch strings.TrimSpace(task.Type) {
	case "canvas_text", "text_replay":
		add(localtask.TargetBindingFromInput(task.InputJSON).NodeID, 0)
	}
	return targets
}

func messageBindTargets(task model.Task, intents []localtask.CanvasBindingIntent) []messageBindTarget {
	seen := map[string]bool{}
	targets := make([]messageBindTarget, 0, len(intents)+1)
	add := func(conversationID, messageID string, outputIndex int) {
		conversationID = strings.TrimSpace(conversationID)
		messageID = strings.TrimSpace(messageID)
		if conversationID == "" || messageID == "" {
			return
		}
		key := conversationID + ":" + messageID + ":" + strconv.Itoa(outputIndex)
		if seen[key] {
			return
		}
		seen[key] = true
		targets = append(targets, messageBindTarget{conversationID: conversationID, messageID: messageID, outputIndex: outputIndex})
	}
	for _, intent := range intents {
		if intent.TargetBinding == nil {
			continue
		}
		add(intent.TargetBinding.ConversationID, intent.TargetBinding.MessageID, intent.OutputIndex)
	}
	target := localtask.TargetBindingFromInput(task.InputJSON)
	add(target.ConversationID, target.MessageID, 0)
	return targets
}

func skippableCanvasBindError(err error) bool {
	if err == nil {
		return true
	}
	if bindInfrastructureUnavailable(err) {
		return true
	}
	reason := canvasBindErrorReason(err)
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

func canvasBindErrorReason(err error) string {
	if err == nil {
		return ""
	}
	var opErr *operations.Error
	if !errors.As(err, &opErr) {
		return ""
	}
	return opErr.Reason
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
