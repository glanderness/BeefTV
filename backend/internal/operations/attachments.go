package operations

import (
	"fmt"
	"math"
	"strings"
)

// AssistantAttachment describes a user-uploaded media asset or arbitrary file
// attached to a built-in assistant message.
type AssistantAttachment struct {
	ResourceID string   `json:"resourceId"`
	Kind       string   `json:"kind"`
	Name       string   `json:"name"`
	MimeType   string   `json:"mimeType"`
	Bytes      int64    `json:"bytes"`
	Purpose    string   `json:"purpose"`
	Start      *float64 `json:"start,omitempty"`
	End        *float64 `json:"end,omitempty"`
	NodeID     string   `json:"nodeId,omitempty"`
	AssetID    string   `json:"assetId,omitempty"`
}

var (
	assistantMediaPurposes = map[string]bool{
		"analysis": true, "character": true, "scene": true, "style": true,
		"motion": true, "first-frame": true, "last-frame": true, "rhythm": true, "sound": true,
	}
	assistantFilePurposes = map[string]bool{
		"analysis": true, "reference": true,
	}
)

// ValidateAssistantAttachments verifies ownership, readiness, kind, purpose,
// and optional media ranges before admitting a chat or supplement turn.
func ValidateAssistantAttachments(domain Domain, userID, canvasID string, items []AssistantAttachment) error {
	if len(items) > 16 {
		return fmt.Errorf("一次最多添加 16 个文件或素材")
	}
	for _, a := range items {
		if strings.TrimSpace(a.ResourceID) == "" || len(a.Name) > 512 {
			return fmt.Errorf("附件信息不完整")
		}
		if a.Kind == "file" {
			if !assistantFilePurposes[a.Purpose] {
				return fmt.Errorf("文件用途无效")
			}
			if a.Start != nil || a.End != nil {
				return fmt.Errorf("文档类附件不支持片段时间范围")
			}
			if strings.TrimSpace(a.NodeID) != "" || strings.TrimSpace(a.AssetID) != "" {
				if _, err := ValidateMediaReference(domain, userID, canvasID, a.NodeID, a.AssetID, a.ResourceID); err != nil {
					return err
				}
				continue
			}
			res, err := domain.OwnedReadyResource(userID, strings.TrimSpace(a.ResourceID))
			if err != nil || res == nil {
				return fmt.Errorf("附件文件不存在或尚未保存完成")
			}
			continue
		}
		if !assistantMediaPurposes[a.Purpose] {
			return fmt.Errorf("素材信息不完整")
		}
		if a.Kind != "image" && a.Kind != "video" && a.Kind != "audio" {
			return fmt.Errorf("不支持的附件类型")
		}
		for _, n := range []*float64{a.Start, a.End} {
			if n != nil && (math.IsNaN(*n) || math.IsInf(*n, 0) || *n < 0 || *n > 86400) {
				return fmt.Errorf("素材片段时间无效")
			}
		}
		if a.Start != nil && a.End != nil && *a.End <= *a.Start {
			return fmt.Errorf("片段结束时间必须晚于开始时间")
		}
		mime, err := ValidateMediaReference(domain, userID, canvasID, a.NodeID, a.AssetID, a.ResourceID)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(mime, a.Kind+"/") {
			return fmt.Errorf("素材类型与实际文件不一致")
		}
	}
	return nil
}
