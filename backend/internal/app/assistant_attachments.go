package app

import "infinite-canvas/backend/internal/operations"

type AssistantAttachment = operations.AssistantAttachment

func (s *Service) ValidateAssistantAttachments(userID, canvasID string, items []AssistantAttachment) error {
	return operations.ValidateAssistantAttachments(s.BindDomain(nil), userID, canvasID, items)
}
