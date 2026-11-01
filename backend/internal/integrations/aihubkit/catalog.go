package aihubkit

import (
	"encoding/json"
	"strings"
)

// Only explicit endpoint contracts select a protocol. Unknown models remain
// available in the account catalog for manual protocol selection.
func modelProtocol(m CatalogModel) (capability, protocol string) {
	for _, endpoint := range m.Endpoints {
		switch strings.ToLower(endpoint) {
		case "openai-video", "aihubkit-video":
			return "video", "aihubkit-video"
		case "image-generation":
			return "image", "openai-image"
		case "openai-response":
			return "text", "openai-response"
		case "anthropic":
			return "text", "claude-api"
		case "gemini":
			return "text", "gemini-generate-content"
		}
	}
	for _, endpoint := range m.Endpoints {
		if endpoint == "openai" {
			return "text", "chat-completion"
		}
	}
	return "", ""
}

func (a *account) seedModels() error {
	body, err := a.service.ReadLocalModelConfig()
	if err != nil {
		return err
	}
	config := map[string]any{}
	if len(body) > 0 {
		if err = json.Unmarshal(body, &config); err != nil {
			return err
		}
	}
	id := "aihubkit-" + a.user.Group
	channels, _ := config["channels"].([]any)
	for _, value := range channels {
		if channel, ok := value.(map[string]any); ok && channel["id"] == id {
			return nil
		}
	}
	models := []string{}
	profiles := []map[string]any{}
	selected := map[string]bool{}
	for _, m := range a.models {
		capability, protocol := modelProtocol(m)
		if capability == "" {
			continue
		}
		models = append(models, m.ID)
		profiles = append(profiles, map[string]any{"model": m.ID, "capability": capability, "protocol": protocol})
		if !selected[capability] && strings.TrimSpace(stringConfig(config[capability+"Model"])) == "" {
			config[capability+"Model"] = id + "::" + m.ID
			selected[capability] = true
		}
	}
	channel := map[string]any{"id": id, "name": "aihubkit · " + a.user.Group, "scope": "user", "enabled": true, "pinned": true, "apiFormat": "openai", "baseUrl": a.client.origin, "interfaceType": "chat-completion", "apiKey": "", "hasApiKey": true, "credentialRef": credentialPrefix + a.user.Group, "models": models, "modelProfiles": profiles}
	config["channels"] = append(channels, channel)
	b, err := json.Marshal(config)
	if err != nil {
		return err
	}
	return a.service.SaveLocalModelConfig(b)
}

func stringConfig(value any) string {
	valueString, _ := value.(string)
	return valueString
}
