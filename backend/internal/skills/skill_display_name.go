package skills

import "fmt"

// Technical names identify a package; a Chinese document title is its display name.
func isTechnicalSkillName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func (s *Service) ensureSkillDisplayNames() error {
	rows, err := s.repo.SkillsForDisplayNameEnsure()
	if err != nil {
		return err
	}
	for _, skill := range rows {
		metadata := parseSkillPackageMetadata([]byte(skill.Instruction))
		// Only repair the original technical name, preserving custom names and package bytes.
		if skill.Name != metadata.TechnicalName || metadata.Name == skill.Name || metadata.Name == "" {
			continue
		}
		skill.Name = metadata.Name
		if err := s.repo.SaveSkill(&skill); err != nil {
			return fmt.Errorf("更新技能显示名称失败: %w", err)
		}
	}
	return nil
}
