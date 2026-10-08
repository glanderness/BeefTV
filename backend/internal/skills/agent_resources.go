package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// Pin is the exact installed package selected by the user for a business round.
// Instructions are loaded on demand, never persisted as an alternate package.
type Pin struct {
	SkillID     string `json:"skillId"`
	VersionID   string `json:"versionId"`
	ContentHash string `json:"contentHash"`
}

type AgentResource struct {
	Pin                     Pin                    `json:"pin"`
	Name                    string                 `json:"name"`
	Description             string                 `json:"description"`
	Version                 string                 `json:"version"`
	Instruction             string                 `json:"instruction"`
	Files                   []SkillPackageFileItem `json:"files"`
	UnsupportedCapabilities []string               `json:"unsupportedCapabilities"`
}

type AgentFile struct {
	Pin                Pin                  `json:"pin"`
	File               SkillPackageFileItem `json:"file"`
	Content            string               `json:"content"`
	ExecutionSupported bool                 `json:"executionSupported"`
}

var agentSkillIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func ValidatePin(pin Pin) error {
	if !agentSkillIDPattern.MatchString(pin.SkillID) || !agentSkillIDPattern.MatchString(pin.VersionID) || len(pin.ContentHash) != 64 {
		return kernel.BadAuthRequest("技能选择必须包含技能、版本和内容摘要")
	}
	if _, err := hex.DecodeString(pin.ContentHash); err != nil || strings.ToLower(pin.ContentHash) != pin.ContentHash {
		return kernel.BadAuthRequest("技能内容摘要无效")
	}
	return nil
}

func (s *Service) agentPackage(userID string, pin Pin) (*model.Skill, *model.SkillVersion, []model.SkillFile, error) {
	if err := ValidatePin(pin); err != nil {
		return nil, nil, nil, err
	}
	if s == nil || s.repo == nil || strings.TrimSpace(userID) == "" {
		return nil, nil, nil, kernel.Forbidden("无法读取当前用户技能")
	}
	skill, err := s.visibleSkill(userID, pin.SkillID)
	if err != nil {
		return nil, nil, nil, err
	}
	state, err := s.repo.UserSkillState(userID, pin.SkillID)
	if err != nil {
		return nil, nil, nil, err
	}
	if skill.Status != skillStatusEnabled || state == nil || !state.Added {
		return nil, nil, nil, kernel.Forbidden("技能已停用或未安装，请重新选择可用技能")
	}
	version, err := s.repo.SkillVersion(pin.VersionID)
	if err != nil || version.SkillID != pin.SkillID {
		return nil, nil, nil, kernel.BadAuthRequest("所选技能版本不存在")
	}
	if version.ContentHash != pin.ContentHash {
		return nil, nil, nil, kernel.NewAppError(409, "技能版本内容已变化，请重新选择")
	}
	if version.PackageKey != path.Join(pin.SkillID, pin.VersionID+".zip") {
		return nil, nil, nil, kernel.Forbidden("技能包位置无效")
	}
	files, err := s.repo.SkillFiles(version.ID)
	return skill, version, files, err
}

func (s *Service) AgentVersion(userID string, pin Pin) (*AgentResource, error) {
	skill, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	result := &AgentResource{Pin: pin, Name: skill.Name, Description: skill.Description, Version: version.VersionLabel, Files: []SkillPackageFileItem{}, UnsupportedCapabilities: []string{}}
	for _, file := range files {
		result.Files = append(result.Files, skillFileItem(file))
		if strings.HasPrefix(file.Path, "scripts/") {
			result.UnsupportedCapabilities = []string{"script_execution"}
		}
	}
	entry, err := s.AgentFile(userID, pin, version.EntryPath)
	if err != nil {
		return nil, err
	}
	if len(entry.Content) > 64<<10 {
		return nil, kernel.BadAuthRequest("技能正文超过 64 KiB，请缩小正文并使用参考文件")
	}
	result.Instruction = entry.Content
	return result, nil
}

func (s *Service) AgentFile(userID string, pin Pin, filePath string) (*AgentFile, error) {
	_, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	normalized, err := normalizeSkillPath(filePath)
	if err != nil {
		return nil, err
	}
	if normalized != filePath {
		return nil, kernel.BadAuthRequest("技能文件路径必须是包内相对路径")
	}
	for _, file := range files {
		if file.Path != normalized {
			continue
		}
		if file.Size > 256<<10 || !isPreviewText(file.MimeType, file.Path) {
			return nil, kernel.BadAuthRequest("辅助文件只支持 256 KiB 以内的文本")
		}
		data, err := s.readSkillArchiveEntry(version, normalized)
		if err != nil {
			return nil, kernel.BadAuthRequest("所选技能版本文件不可读取，请重新安装或选择可用版本")
		}
		sum := sha256.Sum256(data)
		if len(data) > 256<<10 || !utf8.Valid(data) || int64(len(data)) != file.Size || hex.EncodeToString(sum[:]) != file.SHA256 {
			return nil, kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
		}
		return &AgentFile{Pin: pin, File: skillFileItem(file), Content: string(data), ExecutionSupported: false}, nil
	}
	return nil, kernel.BadAuthRequest("这个文件不在所选技能版本中")
}

func (s *Service) ValidateAgentSkills(userID string, pins []Pin) ([]Pin, error) {
	if len(pins) > 4 {
		return nil, kernel.BadAuthRequest("每轮最多选择 4 个技能")
	}
	seen := map[string]bool{}
	result := make([]Pin, 0, len(pins))
	total := 0
	for _, pin := range pins {
		if seen[pin.SkillID] {
			return nil, kernel.BadAuthRequest("同一轮不能选择同一技能的多个版本")
		}
		seen[pin.SkillID] = true
		resource, err := s.AgentVersion(userID, pin)
		if err != nil {
			return nil, err
		}
		total += len(resource.Instruction)
		if total > 128<<10 {
			return nil, kernel.BadAuthRequest(fmt.Sprintf("所选技能正文总量超过 %d KiB", 128))
		}
		result = append(result, pin)
	}
	return result, nil
}
