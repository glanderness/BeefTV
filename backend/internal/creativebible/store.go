package creativebible

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

const (
	ScopeProject    = "project"
	ScopeCanvas     = "canvas"
	maxPayloadBytes = 64 << 10
	maxCharacters   = 40
	maxLocations    = 40
	maxDigestRunes  = 500
)

type CharacterEntry struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Appearance       string `json:"appearance,omitempty"`
	Wardrobe         string `json:"wardrobe,omitempty"`
	Voice            string `json:"voice,omitempty"`
	Notes            string `json:"notes,omitempty"`
	ReferenceAssetID string `json:"referenceAssetId,omitempty"`
}

type LocationEntry struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Description      string `json:"description,omitempty"`
	Lighting         string `json:"lighting,omitempty"`
	Notes            string `json:"notes,omitempty"`
	ReferenceAssetID string `json:"referenceAssetId,omitempty"`
}

// Bible stores the shared project-level (or standalone canvas-level) creative
// specification read by the UI, built-in assistant, and external MCP clients.
type Bible struct {
	ScopeKind    string           `json:"scopeKind"`
	ScopeID      string           `json:"scopeId"`
	Title        string           `json:"title,omitempty"`
	Logline      string           `json:"logline,omitempty"`
	VisualStyle  string           `json:"visualStyle,omitempty"`
	ColorPalette string           `json:"colorPalette,omitempty"`
	CameraRules  string           `json:"cameraRules,omitempty"`
	Taboos       string           `json:"taboos,omitempty"`
	Characters   []CharacterEntry `json:"characters"`
	Locations    []LocationEntry  `json:"locations"`
	Revision     int64            `json:"revision"`
	UpdatedAt    string           `json:"updatedAt,omitempty"`
}

// UpdateInput updates fields on a Creative Bible with optimistic revision CAS.
type UpdateInput struct {
	ExpectedRevision *int64            `json:"expectedRevision,omitempty"`
	Title            *string           `json:"title,omitempty"`
	Logline          *string           `json:"logline,omitempty"`
	VisualStyle      *string           `json:"visualStyle,omitempty"`
	ColorPalette     *string           `json:"colorPalette,omitempty"`
	CameraRules      *string           `json:"cameraRules,omitempty"`
	Taboos           *string           `json:"taboos,omitempty"`
	Characters       *[]CharacterEntry `json:"characters,omitempty"`
	Locations        *[]LocationEntry  `json:"locations,omitempty"`
}

func Empty(scopeKind, scopeID string) Bible {
	return Bible{
		ScopeKind:  scopeKind,
		ScopeID:    scopeID,
		Characters: []CharacterEntry{},
		Locations:  []LocationEntry{},
		Revision:   0,
	}
}

func (b Bible) IsEmpty() bool {
	return strings.TrimSpace(b.Title) == "" &&
		strings.TrimSpace(b.Logline) == "" &&
		strings.TrimSpace(b.VisualStyle) == "" &&
		strings.TrimSpace(b.ColorPalette) == "" &&
		strings.TrimSpace(b.CameraRules) == "" &&
		strings.TrimSpace(b.Taboos) == "" &&
		len(b.Characters) == 0 &&
		len(b.Locations) == 0
}

func settingKey(userID, scopeKind, scopeID string) string {
	prefix := "cb:c:"
	if scopeKind == ScopeProject {
		prefix = "cb:p:"
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(userID) + "\x00" + scopeKind + "\x00" + strings.TrimSpace(scopeID)))
	return prefix + hex.EncodeToString(sum[:20])
}

// ResolveScopeForCanvas maps a canvas to its owning project's shared Creative Bible
// when the canvas belongs to a project, or falls back to a canvas-scoped bible.
func ResolveScopeForCanvas(db *gorm.DB, userID, canvasID string) (string, string, error) {
	cleanCanvasID := strings.TrimSpace(canvasID)
	if cleanCanvasID == "" {
		return "", "", kernel.BadAuthRequest("canvasId 必填")
	}
	if db == nil {
		return ScopeCanvas, cleanCanvasID, nil
	}
	var row model.CanvasProject
	err := db.Select("id", "project_id").Where("id = ? AND user_id = ?", cleanCanvasID, userID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", "", kernel.NotFound("画布不存在")
	}
	if err != nil {
		return "", "", err
	}
	if pid := strings.TrimSpace(row.ProjectID); pid != "" {
		return ScopeProject, pid, nil
	}
	return ScopeCanvas, cleanCanvasID, nil
}

// VerifyProjectOwnership confirms the project exists and belongs to userID.
func VerifyProjectOwnership(db *gorm.DB, userID, projectID string) error {
	cleanID := strings.TrimSpace(projectID)
	if cleanID == "" {
		return kernel.BadAuthRequest("projectId 必填")
	}
	if db == nil {
		return kernel.NewAppError(503, "数据库暂不可用")
	}
	var count int64
	if err := db.Model(&model.Project{}).Where("id = ? AND user_id = ?", cleanID, userID).Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return kernel.NotFound("项目不存在")
	}
	return nil
}

func Get(db *gorm.DB, userID, scopeKind, scopeID string) (Bible, error) {
	out := Empty(scopeKind, scopeID)
	if db == nil {
		return out, nil
	}
	var setting model.SystemSetting
	err := db.Select("value_json").First(&setting, "key = ?", settingKey(userID, scopeKind, scopeID)).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal([]byte(setting.ValueJSON), &out); err != nil {
		return Empty(scopeKind, scopeID), nil
	}
	out.ScopeKind = scopeKind
	out.ScopeID = scopeID
	if out.Characters == nil {
		out.Characters = []CharacterEntry{}
	}
	if out.Locations == nil {
		out.Locations = []LocationEntry{}
	}
	return out, nil
}

func Save(db *gorm.DB, userID, scopeKind, scopeID string, in UpdateInput) (Bible, error) {
	if db == nil {
		return Bible{}, kernel.NewAppError(503, "数据库暂不可用")
	}
	if scopeKind != ScopeProject && scopeKind != ScopeCanvas {
		return Bible{}, kernel.BadAuthRequest("设定集作用域无效")
	}
	key := settingKey(userID, scopeKind, scopeID)
	var saved Bible
	err := db.Transaction(func(tx *gorm.DB) error {
		current, err := Get(tx, userID, scopeKind, scopeID)
		if err != nil {
			return err
		}
		if in.ExpectedRevision != nil && *in.ExpectedRevision != current.Revision {
			return kernel.NewAppError(409, fmt.Sprintf("设定集已被更新（当前版本 %d），请刷新后再保存", current.Revision))
		}
		next := current
		if in.Title != nil {
			next.Title = trimMax(*in.Title, 160)
		}
		if in.Logline != nil {
			next.Logline = trimMax(*in.Logline, 2000)
		}
		if in.VisualStyle != nil {
			next.VisualStyle = trimMax(*in.VisualStyle, 2000)
		}
		if in.ColorPalette != nil {
			next.ColorPalette = trimMax(*in.ColorPalette, 1000)
		}
		if in.CameraRules != nil {
			next.CameraRules = trimMax(*in.CameraRules, 2000)
		}
		if in.Taboos != nil {
			next.Taboos = trimMax(*in.Taboos, 2000)
		}
		if in.Characters != nil {
			if len(*in.Characters) > maxCharacters {
				return kernel.BadAuthRequest(fmt.Sprintf("角色档案最多支持 %d 个", maxCharacters))
			}
			chars := make([]CharacterEntry, 0, len(*in.Characters))
			for idx, c := range *in.Characters {
				name := trimMax(c.Name, 120)
				if name == "" {
					continue
				}
				id := strings.TrimSpace(c.ID)
				if id == "" {
					id = fmt.Sprintf("char-%d", idx+1)
				}
				chars = append(chars, CharacterEntry{
					ID:               trimMax(id, 64),
					Name:             name,
					Appearance:       trimMax(c.Appearance, 800),
					Wardrobe:         trimMax(c.Wardrobe, 500),
					Voice:            trimMax(c.Voice, 300),
					Notes:            trimMax(c.Notes, 800),
					ReferenceAssetID: trimMax(c.ReferenceAssetID, 80),
				})
			}
			next.Characters = chars
		}
		if in.Locations != nil {
			if len(*in.Locations) > maxLocations {
				return kernel.BadAuthRequest(fmt.Sprintf("场景档案最多支持 %d 个", maxLocations))
			}
			locs := make([]LocationEntry, 0, len(*in.Locations))
			for idx, l := range *in.Locations {
				name := trimMax(l.Name, 120)
				if name == "" {
					continue
				}
				id := strings.TrimSpace(l.ID)
				if id == "" {
					id = fmt.Sprintf("loc-%d", idx+1)
				}
				locs = append(locs, LocationEntry{
					ID:               trimMax(id, 64),
					Name:             name,
					Description:      trimMax(l.Description, 800),
					Lighting:         trimMax(l.Lighting, 400),
					Notes:            trimMax(l.Notes, 800),
					ReferenceAssetID: trimMax(l.ReferenceAssetID, 80),
				})
			}
			next.Locations = locs
		}
		next.Revision = current.Revision + 1
		next.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		encoded, err := json.Marshal(next)
		if err != nil {
			return err
		}
		if len(encoded) > maxPayloadBytes {
			return kernel.BadAuthRequest("创作设定集内容超过 64KB 上限，请精简后再保存")
		}
		var existing model.SystemSetting
		findErr := tx.Select("key").First(&existing, "key = ?", key).Error
		if errors.Is(findErr, gorm.ErrRecordNotFound) {
			if err := tx.Create(&model.SystemSetting{Key: key, ValueJSON: string(encoded), UpdatedBy: userID}).Error; err != nil {
				return err
			}
		} else if findErr != nil {
			return findErr
		} else {
			if err := tx.Model(&model.SystemSetting{}).Where("key = ?", key).Updates(map[string]any{
				"value_json": string(encoded),
				"updated_by": userID,
			}).Error; err != nil {
				return err
			}
		}
		saved = next
		return nil
	})
	return saved, err
}

// FormatDigest produces a compact, deterministic summary for <beeftv_studio>.
// Returns "" when the bible is empty so projects without one pay zero tokens.
func FormatDigest(b Bible) string {
	if b.IsEmpty() {
		return ""
	}
	var lines []string
	header := "创作设定集"
	if b.Title != "" {
		header += "「" + clipRunes(b.Title, 32) + "」"
	}
	if b.Revision > 0 {
		header += fmt.Sprintf("（v%d，改稿和写提示词时务必遵守）", b.Revision)
	}
	lines = append(lines, header+"：")
	if b.Logline != "" {
		lines = append(lines, "  世界观/故事："+clipRunes(b.Logline, 220))
	}
	if b.VisualStyle != "" {
		lines = append(lines, "  画风质感："+clipRunes(b.VisualStyle, 220))
	}
	if b.ColorPalette != "" {
		lines = append(lines, "  色彩规范："+clipRunes(b.ColorPalette, 160))
	}
	if b.CameraRules != "" {
		lines = append(lines, "  镜头节奏："+clipRunes(b.CameraRules, 200))
	}
	if b.Taboos != "" {
		lines = append(lines, "  创作禁忌："+clipRunes(b.Taboos, 220))
	}
	if len(b.Characters) > 0 {
		parts := make([]string, 0, min(len(b.Characters), 8))
		for i, c := range b.Characters {
			if i >= 8 {
				break
			}
			desc := []string{}
			if c.Appearance != "" {
				desc = append(desc, clipRunes(c.Appearance, 80))
			}
			if c.Wardrobe != "" {
				desc = append(desc, "服装:"+clipRunes(c.Wardrobe, 50))
			}
			if c.Voice != "" {
				desc = append(desc, "音色:"+clipRunes(c.Voice, 40))
			}
			if c.ReferenceAssetID != "" {
				desc = append(desc, "参考素材:"+c.ReferenceAssetID)
			}
			parts = append(parts, c.Name+"("+strings.Join(desc, "，")+")")
		}
		suffix := ""
		if len(b.Characters) > 8 {
			suffix = fmt.Sprintf("…共 %d 个角色", len(b.Characters))
		}
		lines = append(lines, "  角色："+strings.Join(parts, "；")+suffix)
	}
	if len(b.Locations) > 0 {
		parts := make([]string, 0, min(len(b.Locations), 6))
		for i, l := range b.Locations {
			if i >= 6 {
				break
			}
			desc := []string{}
			if l.Description != "" {
				desc = append(desc, clipRunes(l.Description, 70))
			}
			if l.Lighting != "" {
				desc = append(desc, "光影:"+clipRunes(l.Lighting, 40))
			}
			if l.ReferenceAssetID != "" {
				desc = append(desc, "参考素材:"+l.ReferenceAssetID)
			}
			parts = append(parts, l.Name+"("+strings.Join(desc, "，")+")")
		}
		suffix := ""
		if len(b.Locations) > 6 {
			suffix = fmt.Sprintf("…共 %d 个场景", len(b.Locations))
		}
		lines = append(lines, "  场景："+strings.Join(parts, "；")+suffix)
	}
	return clipRunes(strings.Join(lines, "\n"), maxDigestRunes)
}

func trimMax(raw string, maxRunes int) string {
	clean := strings.TrimSpace(raw)
	if clean == "" || utf8.RuneCountInString(clean) <= maxRunes {
		return clean
	}
	return clipRunes(clean, maxRunes)
}

func clipRunes(s string, maxRunes int) string {
	if maxRunes <= 0 || utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "…"
}
