package repository

import "infinite-canvas/backend/internal/model"

// providerReferenceCount is one row of the plugin retention audit: how many
// saved records still point at a protocol/provider ID.
type providerReferenceCount struct {
	Provider string
	Total    int64
}

// ChannelModelProtocolReferences counts saved system channel models per
// protocol. A retired protocol plugin must stay executable while a channel
// model still names it, otherwise editing or re-testing that model would lose
// the protocol it executes with.
func (r *Repository) ChannelModelProtocolReferences() (map[string]int64, error) {
	var rows []providerReferenceCount
	err := r.db.Model(&model.ChannelModel{}).
		Select("protocol AS provider, COUNT(*) AS total").
		Where("protocol IS NOT NULL AND protocol <> ''").
		Group("protocol").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return referenceCountMap(rows), nil
}

// TaskProviderReferences counts provider tasks whose result may still need the
// original protocol:
//   - queued or running tasks the worker keeps polling;
//   - failed tasks that already hold an upstream task ID, because result
//     recovery queries the same protocol instead of submitting again;
//   - cancelled tasks whose upstream cancellation is still open.
//
// Finished tasks, tasks that failed before submission and text replay containers
// are excluded: they never call a provider again.
func (r *Repository) TaskProviderReferences() (map[string]int64, error) {
	active := []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}
	var rows []providerReferenceCount
	err := r.db.Model(&model.Task{}).
		Select("provider AS provider, COUNT(*) AS total").
		Where("provider IS NOT NULL AND provider <> ''").
		Where(
			"status IN ? OR (status = ? AND provider_request_id <> '') OR (status = ? AND provider_request_id <> '' AND provider_cancel_status = ?)",
			active, model.TaskStatusFailed, model.TaskStatusCancelled, model.ProviderCancelStatusRequested,
		).
		Group("provider").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return referenceCountMap(rows), nil
}

func referenceCountMap(rows []providerReferenceCount) map[string]int64 {
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		if row.Provider == "" || row.Total <= 0 {
			continue
		}
		counts[row.Provider] = row.Total
	}
	return counts
}
