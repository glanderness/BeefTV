package handler

import (
	"encoding/json"

	"infinite-canvas/backend/internal/app"
)

// Always replace the host field, including cancelled/error terminals. A model
// or host-provided task ID is never a source of playback authority.
func assistantOutputsLine(line []byte, svc *app.Service, userID, canvasID, turnID string) []byte {
	var event map[string]any
	if json.Unmarshal(line, &event) != nil || event["type"] != "turn_end" {
		return line
	}
	outputs := []app.AssistantOutput{}
	if event["turnId"] == turnID {
		if verified, err := svc.AssistantTurnOutputs(userID, canvasID, turnID); err == nil {
			outputs = verified
		}
	}
	event["outputs"] = outputs
	raw, err := json.Marshal(event)
	if err != nil {
		return line
	}
	return append(raw, '\n')
}
