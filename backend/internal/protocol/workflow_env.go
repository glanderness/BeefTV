package protocol

import (
	"encoding/json"
	"strings"
)

func requestAsManifestValue(value any) (any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var result any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func manifestModelID(request GenerationRequest) string {
	modelID := strings.TrimSpace(request.Model)
	if separator := strings.LastIndex(modelID, "::"); separator >= 0 {
		modelID = modelID[separator+2:]
	}
	return strings.ToLower(strings.TrimSpace(modelID))
}

func manifestWorkflowValues(manifest Manifest, request GenerationRequest) map[string]any {
	modelID := manifestModelID(request)
	if modelID == "" {
		return nil
	}
	providerID := strings.TrimSpace(manifest.Metadata.ID)
	for _, workflow := range manifest.Contributes.Workflows {
		if providerID != "" && workflow.ProviderID != "" && !strings.EqualFold(strings.TrimSpace(workflow.ProviderID), providerID) {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(workflow.ID), modelID) {
			continue
		}
		values := make(map[string]any, len(workflow.Parameters))
		params := make([]any, 0, len(workflow.Parameters))
		for _, param := range workflow.Parameters {
			paramValues := make([]any, 0, len(param.Values))
			for _, item := range param.Values {
				paramValues = append(paramValues, item)
			}
			entry := map[string]any{
				"name":        param.Name,
				"type":        param.Type,
				"required":    param.Required,
				"description": param.Description,
				"values":      paramValues,
				"mapping":     param.Mapping,
			}
			if param.Min != nil {
				entry["min"] = *param.Min
			}
			if param.Max != nil {
				entry["max"] = *param.Max
			}
			params = append(params, entry)
			if name := strings.TrimSpace(param.Name); name != "" {
				values[name] = paramValues
			}
			if mapping := strings.TrimSpace(param.Mapping); mapping != "" {
				values[mapping] = paramValues
			}
		}
		defaults, _ := requestAsManifestValue(workflow.Defaults)
		return map[string]any{
			"id":         workflow.ID,
			"label":      workflow.Label,
			"providerId": workflow.ProviderID,
			"capability": string(workflow.Capability),
			"parameters": params,
			"values":     values,
			"defaults":   defaults,
		}
	}
	return nil
}
