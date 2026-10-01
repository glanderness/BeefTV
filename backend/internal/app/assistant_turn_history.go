package app

// AssistantTurnHistoryState supplements pi's conversation history with authoritative business receipts.
// It is a read projection: reading history never settles or cancels an active turn.
type AssistantTurnHistoryState struct {
	Change *AssistantTurnChange
	Undone bool
}

func (s *Service) ReadAssistantTurnHistoryState(userID, canvasID, turnID string) (*AssistantTurnHistoryState, error) {
	state, err := s.assistantTurnsOrInit().History(userID, canvasID, turnID)
	if err != nil || state == nil {
		return nil, err
	}
	return &AssistantTurnHistoryState{Change: state.Change, Undone: state.Undone}, nil
}
