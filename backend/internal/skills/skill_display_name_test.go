package skills

import (
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestImportedSkillUsesChineseHeadingInsteadOfTechnicalName(t *testing.T) {
	s, db := agentSkillFixture(t)
	body := "---\nname: storyboard-text\ndescription: 整理分镜\n---\n# 双镜头文字分镜\n\n正文"
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": body})
	item, err := s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "双镜头文字分镜" {
		t.Fatalf("imported name: %+v %v", item, err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("name", "storyboard-text").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	item, err = s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "双镜头文字分镜" || item.VersionID != pin.VersionID || item.ContentHash != pin.ContentHash {
		t.Fatalf("legacy name repair changed identity: %+v %v", item, err)
	}
	resource, err := s.AgentVersion("owner", pin)
	if err != nil || resource.Name != item.SkillName || resource.Instruction != body {
		t.Fatalf("assistant label/body: %+v %v", resource, err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("name", "我的私人分镜").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	item, err = s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "我的私人分镜" {
		t.Fatalf("custom name replaced: %+v %v", item, err)
	}
}

func TestSkillDisplayNameFallbacks(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{"---\nname: interview-outline\ndescription: 简介\n---\n# 采访提纲", "采访提纲"},
		{"---\nname: material-inventory\ndescription: 简介\n---\n# 素材清单整理", "素材清单整理"},
		{"---\nname: Custom Name\ndescription: 简介\n---\n# 中文标题", "Custom Name"},
		{"---\nname: 自定义名称\ndescription: 简介\n---\n# 中文标题", "自定义名称"},
		{"---\nname: technical-name\ndescription: 简介\n---\nNo title", "technical-name"},
	} {
		if got := parseSkillPackageMetadata([]byte(tc.body)).Name; got != tc.want {
			t.Fatalf("name = %q, want %q", got, tc.want)
		}
	}
}
