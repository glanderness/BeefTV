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

// referenceSnapshot is one startup inventory read, shared by every retention
// decision so a single reconcile never audits the same state twice.
type referenceSnapshot struct {
	usage map[string]ReferenceUsage
	// unavailable means the inventory could not be read at all. Every decision
	// then falls back to keeping the installed definition.
	unavailable bool
}

// snapshotReferences reads the inventory once. A nil source reports "no
// inventory", which keeps the historical behavior of callers that own their
// registry outright.
func (c *Runtime) snapshotReferences() referenceSnapshot {
	if c.references == nil {
		return referenceSnapshot{}
	}
	usage, err := c.references.ReferencedProviders()
	if err != nil {
		return referenceSnapshot{unavailable: true}
	}
	return referenceSnapshot{usage: usage}
}

// present reports whether the inventory can answer questions at all.
func (s referenceSnapshot) present() bool { return s.usage != nil }

// total counts the saved state that still needs this record's protocol IDs.
func (s referenceSnapshot) total(record RegistryRecord) (configured, pending int64) {
	for _, id := range recordProviderIDs(record.Raw) {
		usage := s.usage[id]
		configured += usage.Configured
		pending += usage.PendingTasks
	}
	return configured, pending
}

// retentionDecisions decides which built-in records survive this startup even
// though the release no longer ships their package. A record absent from the
// result is dropped, which keeps the historical cleanup for every plugin
// nothing references any more.
func (c *Runtime) retentionDecisions(missing []RegistryRecord, snapshot referenceSnapshot) map[string]*RetentionView {
	decisions := make(map[string]*RetentionView, len(missing))
	if len(missing) == 0 || c.references == nil {
		return decisions
	}
	if snapshot.unavailable {
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
		if note := retentionFor(record, snapshot); note != nil {
			decisions[record.ID] = note
		}
	}
	return decisions
}

// deferralFor reports that this release must not overwrite an installed
// definition yet, because a task that has not retrieved its result would then
// be polled with a new query path or result mapping.
//
// This is the release-side half of "protect old work": the stored manifest, its
// package hash and the enabled state stay untouched for this startup, and the
// shipped package is adopted on a later startup once the work is done.
// Unfinished work defers an upgrade, and so does saved configuration that uses a
// provider ID the new version drops; a saved connection whose ID survives the
// upgrade never freezes a plugin at an old version. An unreadable inventory also
// defers, because "cannot tell" must not be treated like "nothing pending".
func deferralFor(stored, next RegistryRecord, snapshot referenceSnapshot) *RetentionView {
	// A plugin this release ships but that is not installed yet has no old
	// definition to preserve. Deferring it would make a new plugin silently absent
	// for as long as the inventory stays unreadable, so only an existing record can
	// be deferred.
	if strings.TrimSpace(stored.ID) == "" || len(stored.Raw) == 0 {
		return nil
	}
	// Only the manifest describes how a task is queried and parsed; blob
	// bookkeeping (package path, hash) can change without changing execution.
	// Comparing it keeps a re-packaged identical definition from being reported as
	// a deferred upgrade.
	if string(stored.Raw) == string(next.Raw) {
		return nil
	}
	// A failed inventory is not the same as no inventory: the runtime does have an
	// audit, it just could not read it, so we cannot rule out a task that still
	// needs the installed definition. Keep it rather than let a new query path
	// poll unfinished work.
	if snapshot.unavailable {
		return &RetentionView{
			Reasons: []string{"插件引用盘点失败，无法确认是否仍有任务需要当前版本，升级已推迟"},
		}
	}
	// No audit attached at all (a runtime that owns its registry outright) keeps
	// the historical behavior of adopting the shipped package.
	if !snapshot.present() {
		return nil
	}
	var reasons []string
	if _, pending := snapshot.total(stored); pending > 0 {
		reasons = append(reasons, fmt.Sprintf("%d 个未完成或待取回结果的任务仍在使用该协议的当前版本，升级已推迟到这些任务结束", pending))
	}
	// A saved connection alone does not freeze an upgrade that keeps its protocol
	// ID: the new definition still serves it. An upgrade that removes or renames a
	// provider ID saved configuration still runs with would leave that
	// configuration with no definition at all, so it waits like unfinished work.
	if configured := snapshot.configuredOnlyIn(stored, next); configured > 0 {
		reasons = append(reasons, fmt.Sprintf("新版本删除或改名了 %d 个已保存的连接或模型配置仍在使用的协议，升级已推迟", configured))
	}
	if len(reasons) == 0 {
		return nil
	}
	return &RetentionView{Reasons: reasons}
}

// configuredOnlyIn counts saved configuration that uses an ID the stored record
// answers to but the next one no longer resolves.
//
// The next side counts only what the registry would actually resolve: each
// contributed provider ID and its legacy aliases. The plugin ID is deliberately
// not proof that a protocol survives, because a plugin named like its old
// provider (`xai-video`) can rename that provider (`xai-video-v2`) while keeping
// its own name. An unloadable next manifest resolves nothing, so every saved
// reference defers it.
func (s referenceSnapshot) configuredOnlyIn(stored, next RegistryRecord) int64 {
	kept := resolvableProviderIDs(next.Raw)
	var configured int64
	for _, id := range recordProviderIDs(stored.Raw) {
		if _, ok := kept[id]; !ok {
			configured += s.usage[id].Configured
		}
	}
	return configured
}

// resolvableProviderIDs lists the IDs the registry resolves to this manifest's
// providers once installed: provider IDs and their legacy aliases.
func resolvableProviderIDs(raw []byte) map[string]struct{} {
	ids := make(map[string]struct{})
	adapters, err := protocol.LoadInstalledProviders(raw, nil)
	if err != nil {
		return ids
	}
	for _, adapter := range adapters {
		metadata := adapter.Metadata()
		ids[strings.TrimSpace(metadata.ID)] = struct{}{}
		for _, alias := range metadata.LegacyAliases {
			ids[strings.TrimSpace(alias)] = struct{}{}
		}
	}
	return ids
}

func retentionFor(record RegistryRecord, snapshot referenceSnapshot) *RetentionView {
	configured, pending := snapshot.total(record)
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
