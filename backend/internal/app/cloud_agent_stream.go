package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// newCloudAgentStreamPublisher is the name provider.go still calls when a
// canvas_text task carries AgentRequests (art-critique and similar tool
// generation). If no historical CloudAgentExecution is bound to the task,
// deltas are discarded — the same no-op as before the old runtime left the
// product surface. This must not become a task-text alias: that would change
// live AgentRequests streaming.
func newCloudAgentStreamPublisher(s *Service, userID, taskID, kind string) *taskTextStreamPublisher {
	p := newTaskTextStreamPublisher(s, userID, taskID)
	written := 0
	p.sink = func(delta string) error {
		remaining := 32000 - written
		if remaining <= 0 {
			return nil
		}
		if len(delta) > remaining {
			delta = delta[:remaining]
			for !utf8.ValidString(delta) {
				delta = delta[:len(delta)-1]
			}
		}
		if delta == "" {
			return nil
		}
		for attempt := 0; attempt < 3; attempt++ {
			run, err := s.repo.CloudAgentForActiveTask(userID, taskID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			err = s.repo.MutateCloudAgent(userID, run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
				if current.Status != "running" && current.Status != "queued" {
					return nil
				}
				return appendCloudAgentStreamDelta(current, taskID, kind, delta)
			})
			if errors.Is(err, repository.ErrCreationConflict) {
				continue
			}
			if err == nil {
				written += len(delta)
			}
			return err
		}
		return repository.ErrCreationConflict
	}
	return p
}

type cloudAgentStreamEvent struct {
	EventID   string         `json:"eventId"`
	RunID     string         `json:"runId"`
	Seq       int            `json:"seq"`
	Type      string         `json:"type"`
	Payload   map[string]any `json:"payload"`
	CreatedAt time.Time      `json:"createdAt"`
}

func appendCloudAgentStreamDelta(run *model.CloudAgentExecution, taskID, kind, delta string) error {
	root := map[string]json.RawMessage{}
	if strings.TrimSpace(run.StateJSON) != "" {
		if err := json.Unmarshal([]byte(run.StateJSON), &root); err != nil {
			return err
		}
	}
	var activeTaskID string
	if raw, ok := root["activeTaskId"]; ok {
		if err := json.Unmarshal(raw, &activeTaskID); err != nil {
			return err
		}
	}
	if activeTaskID != taskID {
		return nil
	}
	var events []cloudAgentStreamEvent
	if raw, ok := root["events"]; ok && len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &events); err != nil {
			return err
		}
	}
	messageID := taskID
	if kind == "reasoning_delta" {
		messageID += ":reasoning"
	}
	seq := len(events) + 1
	events = append(events, cloudAgentStreamEvent{
		EventID: fmt.Sprintf("%s:%d", run.ID, seq), RunID: run.ID, Seq: seq, Type: kind,
		Payload: map[string]any{"messageId": messageID, "text": delta}, CreatedAt: time.Now(),
	})
	encoded, err := json.Marshal(events)
	if err != nil {
		return err
	}
	root["events"] = encoded
	next, err := json.Marshal(root)
	if err != nil {
		return err
	}
	run.StateJSON = string(next)
	return nil
}
