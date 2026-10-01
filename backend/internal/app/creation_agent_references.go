package app

import (
	"encoding/json"

	"infinite-canvas/backend/internal/creation"
)

func validateAgentResourcePlaceholders(input canvasGenerationInput) error {
	_, err := resolveAgentResourcePlaceholders(input, false)
	return err
}

// Only hydrated references can replace protocol placeholders. The returned request
// is an in-memory copy and must never be written back to Task.InputJSON.
func resolveAgentResourcePlaceholders(input canvasGenerationInput, hydrate bool) (canvasGenerationInput, error) {
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
	var requests agentToolRequests
	if err = json.Unmarshal(raw, &requests); err != nil {
		return input, err
	}
	input.AgentRequests = &requests
	return input, nil
}
