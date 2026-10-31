package skills

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestArchiveFromMarkdownInfersMetadata(t *testing.T) {
	archive, err := archiveFromMarkdown([]byte("# 小说转分镜\n\n把小说段落拆成可拍摄的镜头。\n"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Name != "小说转分镜" || archive.Metadata.Description != "把小说段落拆成可拍摄的镜头。" {
		t.Fatalf("metadata = %#v", archive.Metadata)
	}
	if string(archive.Files["SKILL.md"]) == "" || archive.ContentHash == "" {
		t.Fatal("archive did not preserve the entry file or compute a hash")
	}
}

func TestArchiveFromZipNormalizesWrapperAndNestedFiles(t *testing.T) {
	data := skillZip(t, map[string]string{
		"director-main/SKILL.md":             "---\nname: AI 导演\ndescription: 导演工作流\nmetadata:\n  version: 2.1\n---\n",
		"director-main/references/camera.md": "# Camera",
		"director-main/scripts/check.js":     "export default true",
	})
	archive, err := archiveFromZip(data, "")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Version != "2.1" || len(archive.Files) != 3 {
		t.Fatalf("archive = %#v", archive)
	}
	if string(archive.Files["references/camera.md"]) != "# Camera" {
		t.Fatalf("nested file missing: %#v", archive.Files)
	}
}

func TestArchiveFromZipRejectsTraversalAndMultipleSkills(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"traversal": {"../SKILL.md": "# Bad"},
		"multiple": {
			"one/SKILL.md": "# One\n\nFirst",
			"two/SKILL.md": "# Two\n\nSecond",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := archiveFromZip(skillZip(t, files), ""); err == nil {
				t.Fatal("expected package validation error")
			}
		})
	}
}

func TestParseGitHubSkillURL(t *testing.T) {
	spec, err := parseGitHubSkillURL("https://github.com/example/beeftv-skills/tree/main/skills/canvas-context", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Owner != "example" || spec.Repo != "beeftv-skills" || spec.Ref != "main" || spec.Subdir != "skills/canvas-context" {
		t.Fatalf("spec = %#v", spec)
	}
	if _, err := parseGitHubSkillURL("https://github.com/example/beeftv-skills/blob/main/SKILL.md", "", ""); err == nil {
		t.Fatal("expected blob URL to be rejected")
	}
}

func TestEnsureSkillPackagesMigratesAndRefreshesBuiltinSkills(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	svc := New(repository.New(db), t.TempDir(), nil)
	builtin := model.Skill{ID: kernel.NewID(), Name: "内置导演", Description: "内置工作流", Instruction: "# 内置导演\n\n第一版", Status: skillStatusEnabled, Source: 3}
	userSkill := model.Skill{ID: kernel.NewID(), Name: "用户技能", Description: "用户工作流", Instruction: "# 用户技能\n\n第一版", Status: skillStatusEnabled, Source: skillSourceUser}
	if err := db.Create(&builtin).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&userSkill).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 1)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 1)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	if err := db.Model(&model.Skill{}).Where("id = ?", builtin.ID).Update("instruction", "# 内置导演\n\n第二版").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", userSkill.ID).Update("instruction", "# 用户技能\n\n不应在启动时重建").Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 2)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	var refreshed model.Skill
	if err := db.First(&refreshed, "id = ?", builtin.ID).Error; err != nil {
		t.Fatal(err)
	}
	wantArchive, err := archiveFromMarkdown([]byte(refreshed.Instruction), refreshed.Name, refreshed.Description)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.ContentHash != wantArchive.ContentHash || refreshed.CurrentVersionID == "" {
		t.Fatalf("builtin package was not refreshed: %#v", refreshed)
	}
}

func TestBuiltinSeedSkillsIncludeLuckyPlusOnePackagesAndAuxiliaryFiles(t *testing.T) {
	svc, _ := agentSkillFixture(t)
	if err := svc.EnsureBuiltinSkills(); err != nil {
		t.Fatalf("EnsureBuiltinSkills: %v", err)
	}
	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatalf("EnsureSkillPackages: %v", err)
	}

	expected := []struct {
		skillID   string
		skillName string
		minFiles  int
		auxPaths  []string
	}{
		{
			skillID:   "novel-to-manju-agent",
			skillName: "小说改编漫剧 Agent",
			minFiles:  20,
			auxPaths:  []string{"references/dialogue.md", "references/requirements.md", "agents/director.md"},
		},
		{
			skillID:   "ai-drama-reference-art",
			skillName: "AI短剧参考图提示词编写",
			minFiles:  1,
			auxPaths:  nil,
		},
		{
			skillID:   "seedance-clip-writer",
			skillName: "Seedance 视频提示词编写",
			minFiles:  9,
			auxPaths:  []string{"references/performance_layer.md", "references/script_to_shot_breakdown.md", "references/transition_grammar.md"},
		},
	}

	var pins []Pin
	for _, tc := range expected {
		detail, err := svc.SkillDetail("tester", tc.skillID)
		if err != nil {
			t.Fatalf("SkillDetail(%s): %v", tc.skillID, err)
		}
		if detail.SkillName != tc.skillName {
			t.Fatalf("%s SkillName = %q, want %q", tc.skillID, detail.SkillName, tc.skillName)
		}
		if detail.EffectiveUser.Name != "lucky加一" || detail.OwnerUID != "lucky-plus-one" {
			t.Fatalf("%s attribution = %+v (owner=%q), want lucky加一 / lucky-plus-one", tc.skillID, detail.EffectiveUser, detail.OwnerUID)
		}
		if detail.FileCount < tc.minFiles {
			t.Fatalf("%s FileCount = %d, want >= %d", tc.skillID, detail.FileCount, tc.minFiles)
		}
		added, err := svc.SetSkillAdded("tester", tc.skillID, true)
		if err != nil {
			t.Fatalf("SetSkillAdded(%s): %v", tc.skillID, err)
		}
		pin := Pin{SkillID: added.SkillID, VersionID: added.VersionID, ContentHash: added.ContentHash}
		pins = append(pins, pin)

		resource, err := svc.AgentVersion("tester", pin)
		if err != nil {
			t.Fatalf("AgentVersion(%s): %v", tc.skillID, err)
		}
		if !strings.Contains(resource.Instruction, "lucky加一") {
			t.Fatalf("%s instruction missing attribution lucky加一", tc.skillID)
		}
		for _, auxPath := range tc.auxPaths {
			file, err := svc.AgentFile("tester", pin, auxPath)
			if err != nil || strings.TrimSpace(file.Content) == "" {
				t.Fatalf("AgentFile(%s, %s) failed: err=%v", tc.skillID, auxPath, err)
			}
		}
	}

	if _, err := svc.ValidateAgentSkills("tester", pins); err != nil {
		t.Fatalf("ValidateAgentSkills(all 3 lucky加一 skills): %v", err)
	}
}

func assertSkillVersionCount(t *testing.T, db *gorm.DB, skillID string, want int64) {
	t.Helper()
	var got int64
	if err := db.Model(&model.SkillVersion{}).Where("skill_id = ?", skillID).Count(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("skill %s version count = %d, want %d", skillID, got, want)
	}
}

func skillZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for filePath, content := range files {
		entry, err := writer.Create(filePath)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
