package repository

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Project export, assistant file export, and persisted skill-script output receipts
// own standalone deliverables that are not inserted into the canvas document, so
// background orphan cleanup must keep them alive.
func (r *Repository) ProjectExportResourceReferences(userID string, resourceIDs []string) ([]ResourceDirectReference, error) {
	if len(resourceIDs) == 0 || !r.db.Migrator().HasTable(&model.AgentOpRecord{}) {
		return nil, nil
	}
	wanted := make(map[string]bool, len(resourceIDs))
	for _, id := range resourceIDs {
		wanted[id] = true
	}
	var records []model.AgentOpRecord
	query := applySQLiteReferenceFilter(
		r.db.Select("op_id", "op", "result_json").Where("user_id = ? AND op IN ? AND status = ? AND result_json <> ''", userID, []string{"canvas.project.export", "file.export"}, "succeeded"),
		"result_json",
	)
	if err := query.Find(&records).Error; err != nil {
		return nil, err
	}
	var references []ResourceDirectReference
	for _, record := range records {
		var receipt struct {
			ResourceID string `json:"resourceId"`
			StorageKey string `json:"storageKey"`
			FileName   string `json:"fileName"`
		}
		if err := json.Unmarshal([]byte(record.ResultJSON), &receipt); err != nil {
			continue
		}
		id := strings.TrimSpace(receipt.ResourceID)
		if !wanted[id] || receipt.StorageKey != "resource:"+id {
			continue
		}
		kind, title := "工程导出", "BeefTV 工程"
		if record.Op == "file.export" {
			kind = "助手交付文件"
			title = strings.TrimSpace(receipt.FileName)
			if title == "" {
				title = "交付文件"
			}
		}
		references = append(references, ResourceDirectReference{Kind: kind, ID: record.OpID, Title: title, ResourceID: id})
	}

	var scriptRecords []model.AgentOpRecord
	if err := r.db.Select("op_id", "result_json").
		Where("user_id = ? AND op = ? AND result_json <> '' AND instr(result_json, ?) > 0", userID, "skill.script.proposal", `"resourceId"`).
		Find(&scriptRecords).Error; err != nil {
		return nil, err
	}
	for _, record := range scriptRecords {
		var proposal struct {
			Result *struct {
				OutputFiles []struct {
					Path       string `json:"path"`
					ResourceID string `json:"resourceId"`
				} `json:"outputFiles"`
			} `json:"result"`
		}
		if err := json.Unmarshal([]byte(record.ResultJSON), &proposal); err != nil || proposal.Result == nil {
			continue
		}
		for _, item := range proposal.Result.OutputFiles {
			id := strings.TrimSpace(item.ResourceID)
			if !wanted[id] {
				continue
			}
			title := strings.TrimSpace(item.Path)
			if title == "" {
				title = "脚本产物"
			}
			references = append(references, ResourceDirectReference{Kind: "技能脚本产物", ID: record.OpID, Title: title, ResourceID: id})
		}
	}
	return references, nil
}
