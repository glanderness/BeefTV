package handler

import "infinite-canvas/backend/internal/skills"

// labelAssistantSkills fills skill display labels on host turn records from
// the pins Go validated for that round. The host only echoes pin identity;
// a skill without a stored label stays unlabeled for the UI fallback.
func labelAssistantSkills(turn map[string]any, pins []skills.Pin) {
	if turn == nil {
		return
	}
	labels := make(map[string]skills.Pin, len(pins))
	for _, pin := range pins {
		labels[pin.SkillID] = pin
	}
	label := func(value any) {
		list, _ := value.([]any)
		for _, item := range list {
			skill, ok := item.(map[string]any)
			if !ok {
				continue
			}
			delete(skill, "skillName")
			delete(skill, "version")
			id, _ := skill["skillId"].(string)
			versionID, _ := skill["versionId"].(string)
			pin, found := labels[id]
			if !found || pin.VersionID != versionID || pin.SkillName == "" {
				continue
			}
			skill["skillName"] = pin.SkillName
			if pin.Version != "" {
				skill["version"] = pin.Version
			}
		}
	}
	label(turn["skills"])
	inputs, _ := turn["supplementInputs"].([]any)
	for _, value := range inputs {
		if input, ok := value.(map[string]any); ok {
			label(input["skills"])
		}
	}
}
