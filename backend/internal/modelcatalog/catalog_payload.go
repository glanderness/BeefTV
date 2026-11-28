package modelcatalog

import "strings"

func NormalizeCatalogModelType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "text", "image", "video", "audio":
		return normalized
	default:
		return ""
	}
}

func NormalizeCatalogOptions(options []ChannelModelCatalogOption) []ChannelModelCatalogOption {
	seen := make(map[string]bool, len(options))
	normalized := make([]ChannelModelCatalogOption, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		normalized = append(normalized, ChannelModelCatalogOption{Value: value, Label: strings.TrimSpace(option.Label)})
	}
	return normalized
}

func NormalizeCatalogEndpointTypes(values []string) []string {
	seen := make(map[string]bool, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		item := strings.TrimSpace(value)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		normalized = append(normalized, item)
	}
	return normalized
}

func NormalizeCatalogInputModalities(groups ...[]string) []string {
	seen := map[string]bool{}
	var normalized []string
	for _, group := range groups {
		for _, raw := range group {
			item := strings.ToLower(strings.TrimSpace(raw))
			switch {
			case item == "text" || item == "image" || item == "video" || item == "audio":
			case item == "vision" || strings.HasPrefix(item, "image/"):
				item = "image"
			case item == "video/mp4":
				item = "video"
			case item == "audio/wav":
				item = "audio"
			default:
				item = ""
			}
			if item == "" || seen[item] {
				continue
			}
			seen[item] = true
			normalized = append(normalized, item)
		}
	}
	return normalized
}
