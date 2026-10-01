package generation

import (
	"encoding/json"

	"infinite-canvas/backend/internal/creation"
)

func ResolveAgentResourcePlaceholders(input Input, hydrate bool) (Input, error) {
	if input.AgentRequests == nil {
		return input, nil
	}
	refs := make([]creation.MediaRef, 0, len(input.ReferenceImages))
	for _, media := range input.ReferenceImages {
		refs = append(refs, creation.MediaRef{StorageKey: media.StorageKey, DataURL: media.DataURL, URL: media.URL})
	}
	resolved, err := creation.ResolveProtocolPlaceholders(refs, input.AgentRequests, hydrate)
	if err != nil {
		return input, err
	}
	if !hydrate {
		return input, nil
	}
	raw, err := json.Marshal(resolved)
	if err != nil {
		return input, err
	}
	var requests AgentToolRequests
	if err = json.Unmarshal(raw, &requests); err != nil {
		return input, err
	}
	input.AgentRequests = &requests
	return input, nil
}
