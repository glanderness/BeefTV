package app

import "infinite-canvas/backend/internal/assistantturns"

func (s *Service) AssistantSkillContext(userID, canvasID, sessionID string) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().SkillContext(userID, canvasID, sessionID)
}

func (s *Service) ChangeAssistantSkillContext(userID, canvasID string, change assistantturns.SkillContextChange) (*assistantturns.SkillContext, error) {
	if change.Action == "activate" || change.Action == "new_scope" {
		pins, err := s.ValidateAgentSkills(userID, change.Pins)
		if err != nil {
			return nil, err
		}
		change.Pins = pins
	} else if change.Action == "refresh" {
		current, err := s.AssistantSkillContext(userID, canvasID, change.SessionID)
		if err != nil {
			return nil, err
		}
		if _, err = s.ValidateAgentSkills(userID, current.ActivePins); err != nil {
			return nil, err
		}
	}
	return s.assistantTurnsOrInit().ChangeSkillContext(userID, canvasID, change)
}

func (s *Service) AcknowledgeAssistantSkillScope(userID, canvasID, sessionID, scopeID string, revision int64) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().AcknowledgeSkillScope(userID, canvasID, sessionID, scopeID, revision)
}

func (s *Service) BoundAssistantSkillContext(userID, turnID, sessionID string) (*assistantturns.SkillContext, error) {
	return s.assistantTurnsOrInit().BoundSkillContext(userID, turnID, sessionID)
}
