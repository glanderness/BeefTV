package repository

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Project export receipts own the standalone ZIP: it is not inserted into the
// canvas, which would recursively include previous exports in the next ZIP.
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
		r.db.Select("op_id", "result_json").Where("user_id = ? AND op = ? AND status = ? AND result_json <> ''", userID, "canvas.project.export", "succeeded"),
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
		}
		if err := json.Unmarshal([]byte(record.ResultJSON), &receipt); err != nil {
			continue
		}
		id := strings.TrimSpace(receipt.ResourceID)
		if !wanted[id] || receipt.StorageKey != "resource:"+id {
			continue
		}
		references = append(references, ResourceDirectReference{Kind: "工程导出", ID: record.OpID, Title: "BeefTV 工程", ResourceID: id})
	}
	return references, nil
}
