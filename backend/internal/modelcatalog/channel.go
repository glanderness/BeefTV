package modelcatalog

import (
	"fmt"
	"strings"
)

func normalizeChannelModelTierResolution(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || value == "*" || strings.EqualFold(value, "any") {
		return "*"
	}
	normalized := normalizeModelRequestOption("vquality", value)
	return strings.ToLower(strings.TrimSpace(fmt.Sprint(normalized)))
}

func protocolCapabilityFromMetadata(metadata ProtocolMeta) string {
	return strings.TrimSpace(metadata.PrimaryCapability)
}
