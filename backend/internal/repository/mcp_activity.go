package repository

import (
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"strings"
)

const retainedMCPCalls = 200

func (r *Repository) RecordMCPCall(call *model.MCPCall, taskIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if len(taskIDs) > 0 {
			var tasks []model.Task
			if err := tx.Select("id, type, provider, model, route_run").Where("user_id = ? AND id IN ?", call.UserID, taskIDs).Order("id").Find(&tasks).Error; err != nil {
				return err
			}
			names := []string{}
			seen := map[string]bool{}
			hasBillable := false
			for _, task := range tasks {
				call.Tasks = append(call.Tasks, model.MCPTaskRun{ID: task.ID, Run: task.RouteRun})
				if task.Model != "" && !seen[task.Model] {
					names = append(names, task.Model)
					seen[task.Model] = true
				}
				if task.Provider != "local" && task.Type != model.TaskTypeCanvasMediaTransform {
					hasBillable = true
				}
			}
			call.ModelName = strings.Join(names, "、")
			if len(tasks) == len(taskIDs) {
				if hasBillable {
					call.Billing = "tasks"
				} else {
					call.Billing = "none"
				}
			}
		}
		if err := tx.Create(call).Error; err != nil {
			return err
		}
		return tx.Exec("DELETE FROM mcp_calls WHERE user_id = ? AND id IN (SELECT id FROM mcp_calls WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)", call.UserID, call.UserID, retainedMCPCalls).Error
	})
}

func (r *Repository) RecentMCPCalls(userID string) ([]model.MCPCall, error) {
	calls := []model.MCPCall{}
	if err := r.db.Where("user_id = ?", userID).Order("created_at DESC, id DESC").Limit(10).Find(&calls).Error; err != nil {
		return nil, err
	}
	var taskIDs []string
	for _, call := range calls {
		for _, task := range call.Tasks {
			taskIDs = append(taskIDs, task.ID)
		}
	}
	if len(taskIDs) == 0 {
		return calls, nil
	}
	var totals []struct {
		TaskID   string
		RouteRun int
		Quota    *int64
	}
	// A missing receipt for even one attempt makes the whole amount unknown.
	err := r.db.Raw(`SELECT a.task_id, a.route_run,
 CASE WHEN COUNT(*) = COUNT(s.settled_quota) THEN SUM(s.settled_quota) END AS quota
 FROM route_attempts a JOIN tasks t ON t.id=a.task_id AND t.user_id=?
 LEFT JOIN image_submissions s ON s.attempt_id=a.id AND s.task_id=t.id AND s.user_id=t.user_id
 WHERE a.task_id IN ? AND (t.route_run != a.route_run OR t.status IN ('succeeded','failed','cancelled'))
 GROUP BY a.task_id,a.route_run`, userID, taskIDs).Scan(&totals).Error
	if err != nil {
		return nil, err
	}
	byRun := map[model.MCPTaskRun]*int64{}
	for _, item := range totals {
		byRun[model.MCPTaskRun{ID: item.TaskID, Run: item.RouteRun}] = item.Quota
	}
	for i := range calls {
		call := &calls[i]
		if call.Billing != "tasks" {
			continue
		}
		var quota int64
		for _, task := range call.Tasks {
			amount := byRun[task]
			if amount == nil {
				quota = -1
				break
			}
			quota += *amount
		}
		if quota >= 0 && len(call.Tasks) > 0 && (call.QuotaPerYuan > 0 || quota == 0) {
			amount := float64(quota) / float64(max(call.QuotaPerYuan, 1))
			call.AmountCNY = &amount
		}
	}
	return calls, nil
}
