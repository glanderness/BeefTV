package app

import "infinite-canvas/backend/internal/skills"

func (s *Service) ValidateAgentSkills(userID string, pins []skills.Pin) ([]skills.Pin, error) {
	return s.skillDomain().ValidateAgentSkills(userID, pins)
}
func (s *operationSession) AgentSkillVersion(userID string, pin skills.Pin) (*skills.AgentResource, error) {
	return s.service.skillDomain().AgentVersion(userID, pin)
}
func (s *operationSession) AgentSkillFile(userID string, pin skills.Pin, path string) (*skills.AgentFile, error) {
	return s.service.skillDomain().AgentFile(userID, pin, path)
}
