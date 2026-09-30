package app

import (
	"errors"
	"os"
)

// AssistantTurnHistoryState supplements pi's conversation history with authoritative business receipts.
// It is a read projection: reading history never settles or cancels an active turn.
type AssistantTurnHistoryState struct {
	Change *AssistantTurnChange
	Undone bool
}

func (s *Service) ReadAssistantTurnHistoryState(userID, canvasID, turnID string) (*AssistantTurnHistoryState, error) {
	path := s.assistantTurnPath(turnID)
	if path == "" {
		return nil, nil
	}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	record, err := readAssistantTurn(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if record.UserID != userID || record.CanvasID != canvasID {
		return nil, nil
	}
	change := record.Change
	if record.State == assistantTurnStateOpen && !record.Undone {
		change, err = s.assistantTurnChangeFromReceipts(record)
		if err != nil {
			return nil, err
		}
	}
	return &AssistantTurnHistoryState{Change: change, Undone: record.Undone}, nil
}
