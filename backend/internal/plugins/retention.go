package plugins

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/protocol"
)

// ReferenceUsage counts the saved state that still needs one provider ID. The
// audit only counts references; it never reads, copies or returns credentials.
type ReferenceUsage struct {
	// Configured counts saved connections and model profiles that name the ID.
	Configured int64 `json:"configured"`
	// PendingTasks counts tasks whose result may still be retrieved through the
	// original protocol: queued/running work, failed tasks that still hold an
	// upstream task ID, and cancelled tasks whose upstream cancellation is open.
	PendingTasks int64 `json:"pendingTasks"`
}

// ReferenceSource reports the provider IDs that saved configuration or
// unfinished tasks still need. It exists so bootstrap can stop a release from
// deleting an official plugin that old configuration still executes with.
//
// Implementations read local state only and must never log or expose credential
// material. A nil source means the caller has no inventory, and the historical
// "drop every built-in this release no longer ships" behavior stays in effect.
type ReferenceSource interface {
	ReferencedProviders() (map[string]ReferenceUsage, error)
}

// RetentionView explains why a plugin this release no longer ships is still
// installed. It is derived on every startup from saved configuration and
// unfinished tasks, so it is never persisted and never becomes a second source
// of truth: once the last reference disappears, the next startup stops
// retaining the record.
type RetentionView struct {
	// Retired marks a plugin that stays executable but must not be offered for
	// new selections.
	Retired bool `json:"retired"`
	// Reasons are user-facing explanations, e.g. "2 个未完成的任务仍在使用该协议".
	Reasons []string `json:"reasons,omitempty"`
	// Unknown reports that the reference inventory could not be read and the
	// plugin was retained conservatively instead of being deleted.
	Unknown bool `json:"unknown,omitempty"`
}

func cloneRetention(note *RetentionView) *RetentionView {
	if note == nil {
		return nil
	}
	return &RetentionView{Retired: note.Retired, Unknown: note.Unknown, Reasons: cloneStringSlice(note.Reasons)}
}

// retentionDecisions decides which built-in records survive this startup even
// though the release no longer ships their package. A record absent from the
// result is dropped, which keeps the historical cleanup for every plugin
// nothing references any more.
func (c *Runtime) retentionDecisions(missing []RegistryRecord) map[string]*RetentionView {
	decisions := make(map[string]*RetentionView, len(missing))
	if len(missing) == 0 || c.references == nil {
		return decisions
	}
	references, err := c.references.ReferencedProviders()
	if err != nil {
		// An unreadable inventory must never delete an executable protocol.
		for _, record := range missing {
			decisions[record.ID] = &RetentionView{
				Retired: true,
				Unknown: true,
				Reasons: []string{"插件引用盘点失败，已按保守策略保留该协议"},
			}
		}
		return decisions
	}
	for _, record := range missing {
		if note := retentionFor(record, references); note != nil {
			decisions[record.ID] = note
		}
	}
	return decisions
}

func retentionFor(record RegistryRecord, references map[string]ReferenceUsage) *RetentionView {
	var configured, pending int64
	for _, id := range recordProviderIDs(record.Raw) {
		usage := references[id]
		configured += usage.Configured
		pending += usage.PendingTasks
	}
	if configured <= 0 && pending <= 0 {
		return nil
	}
	note := &RetentionView{Retired: true}
	if configured > 0 {
		note.Reasons = append(note.Reasons, fmt.Sprintf("%d 个已保存的连接或模型配置仍在使用该协议", configured))
	}
	if pending > 0 {
		note.Reasons = append(note.Reasons, fmt.Sprintf("%d 个未完成或待取回结果的任务仍在使用该协议", pending))
	}
	return note
}

// recordProviderIDs lists every ID a saved configuration may use to reach this
// plugin: the plugin ID itself plus each contributed provider ID. Configuration
// and tasks store provider IDs such as `newapi` for the `openai-videos` package,
// so matching on the package ID alone would miss real references.
func recordProviderIDs(raw []byte) []string {
	var manifest protocol.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(manifest.Contributes.Providers)+1)
	ids := make([]string, 0, len(manifest.Contributes.Providers)+1)
	appendID := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	appendID(manifest.Metadata.ID)
	for _, provider := range manifest.Contributes.Providers {
		appendID(provider.ID)
	}
	sort.Strings(ids)
	return ids
}

func applyRetention(plugins map[string]Record, notes map[string]*RetentionView) {
	for id, note := range notes {
		record, ok := plugins[id]
		if !ok {
			continue
		}
		record.Retention = cloneRetention(note)
		plugins[id] = record
	}
}
