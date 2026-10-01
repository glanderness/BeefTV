package modelcatalog

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

// ProtocolMeta is the slice of protocol.Metadata that catalog/channel rules
// actually consult. The protocol plugin worker owns the live registry.
type ProtocolMeta struct {
	ID                string
	Enabled           bool
	UnavailableReason string
	PrimaryCapability string
}

// ProtocolLookup resolves a protocol id (including official aliases) to metadata.
type ProtocolLookup func(id string) (ProtocolMeta, bool)

// ChannelModelLookup loads one configured channel model by channel and key.
type ChannelModelLookup func(channelID, modelKey string) (*model.ChannelModel, error)

// LookupFromRegistry adapts protocol.Registry.Resolve without exposing Adapter.
func LookupFromRegistry(registry *protocol.Registry) ProtocolLookup {
	if registry == nil {
		return func(string) (ProtocolMeta, bool) { return ProtocolMeta{}, false }
	}
	return func(id string) (ProtocolMeta, bool) {
		adapter, ok := registry.Resolve(strings.TrimSpace(id))
		if !ok {
			return ProtocolMeta{}, false
		}
		metadata := adapter.Metadata()
		primary := ""
		if len(metadata.Categories) > 0 {
			primary = string(metadata.Categories[0])
		}
		return ProtocolMeta{
			ID:                metadata.ID,
			Enabled:           metadata.Enabled,
			UnavailableReason: metadata.UnavailableReason,
			PrimaryCapability: primary,
		}, true
	}
}
