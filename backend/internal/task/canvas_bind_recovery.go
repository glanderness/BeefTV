package task

import (
	"encoding/json"
	"strings"
)

const canvasBindRecoveryPrefix = "canvas_bind:"

// CanvasBindRecovery records a terminal bind refusal without creating a second
// task lifecycle. It lives in the existing private recovery_outcome column.
// The successful task outcome remains owned by ComputeOutcome; this marker only
// controls the background delivery scanner.
type CanvasBindRecovery struct {
	Version int                        `json:"version"`
	Targets []CanvasBindRecoveryTarget `json:"targets"`
}

type CanvasBindRecoveryTarget struct {
	NodeID                string `json:"nodeId"`
	OutputIndex           int    `json:"outputIndex"`
	Reason                string `json:"reason"`
	NodePresent           bool   `json:"nodePresent"`
	NodeTaskID            string `json:"nodeTaskId,omitempty"`
	NodeType              string `json:"nodeType,omitempty"`
	NodeClientOperationID string `json:"nodeClientOperationId,omitempty"`
	NodeStatus            string `json:"nodeStatus,omitempty"`
	NodeHasMedia          bool   `json:"nodeHasMedia"`
}

// DecodeCanvasBindRecovery accepts only the marker written by this package.
// Existing image recovery conclusions (no_result/unrecoverable) remain
// untouched and continue to be interpreted by ComputeOutcome.
func DecodeCanvasBindRecovery(raw *string) (CanvasBindRecovery, bool) {
	if raw == nil || !strings.HasPrefix(*raw, canvasBindRecoveryPrefix) {
		return CanvasBindRecovery{}, false
	}
	var state CanvasBindRecovery
	if json.Unmarshal([]byte(strings.TrimPrefix(*raw, canvasBindRecoveryPrefix)), &state) != nil || state.Version != 2 {
		return CanvasBindRecovery{}, false
	}
	return state, true
}

func EncodeCanvasBindRecovery(state CanvasBindRecovery) (*string, error) {
	state.Version = 2
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	value := canvasBindRecoveryPrefix + string(encoded)
	return &value, nil
}

func (state *CanvasBindRecovery) Target(nodeID string, outputIndex int) (CanvasBindRecoveryTarget, bool) {
	if state == nil {
		return CanvasBindRecoveryTarget{}, false
	}
	for _, target := range state.Targets {
		if target.NodeID == strings.TrimSpace(nodeID) && target.OutputIndex == outputIndex {
			return target, true
		}
	}
	return CanvasBindRecoveryTarget{}, false
}

func (state *CanvasBindRecovery) Upsert(target CanvasBindRecoveryTarget) {
	if state == nil || strings.TrimSpace(target.NodeID) == "" {
		return
	}
	target.NodeID = strings.TrimSpace(target.NodeID)
	target.NodeTaskID = strings.TrimSpace(target.NodeTaskID)
	for i := range state.Targets {
		if state.Targets[i].NodeID == target.NodeID && state.Targets[i].OutputIndex == target.OutputIndex {
			state.Targets[i] = target
			return
		}
	}
	state.Targets = append(state.Targets, target)
}

func (state *CanvasBindRecovery) Remove(nodeID string, outputIndex int) bool {
	if state == nil {
		return false
	}
	nodeID = strings.TrimSpace(nodeID)
	for i, target := range state.Targets {
		if target.NodeID == nodeID && target.OutputIndex == outputIndex {
			state.Targets = append(state.Targets[:i], state.Targets[i+1:]...)
			return true
		}
	}
	return false
}

func (state CanvasBindRecovery) Empty() bool { return len(state.Targets) == 0 }
