package providerpreset

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// Protocol defaults are shared with the web client, which reads the same file
// (web/src/lib/model-protocols.ts). Both sides answer "which protocol does this
// saved model run with" from it, so the startup plugin audit counts exactly the
// protocols that requests will use.
//
//   - legacy: what a saved profile without a protocol field has always meant.
//     Older configurations omit the field and still execute with it.
//   - preferred: the order a new model is offered a selectable protocol in.
//   - capabilityKeywords: how a model name implies its capability when the
//     profile does not store one. The first matching group wins; no match is text.
//
//go:embed protocol_defaults.json
var protocolDefaultsJSON []byte

type protocolDefaults struct {
	Legacy             map[string]string   `json:"legacy"`
	Preferred          map[string][]string `json:"preferred"`
	CapabilityKeywords []struct {
		Capability string   `json:"capability"`
		Keywords   []string `json:"keywords"`
	} `json:"capabilityKeywords"`
}

var defaults = func() protocolDefaults {
	var parsed protocolDefaults
	if err := json.Unmarshal(protocolDefaultsJSON, &parsed); err != nil {
		panic(err)
	}
	return parsed
}()

// LegacyDefaultProtocol returns the protocol a saved profile of this capability
// executes with when it stores no protocol of its own. Video has none: a video
// model must name its protocol.
func LegacyDefaultProtocol(capability string) string {
	return defaults.Legacy[strings.TrimSpace(capability)]
}

// InferModelCapability mirrors inferProtocolCapabilityFromModel on the web.
func InferModelCapability(model string) string {
	lower := strings.ToLower(model)
	for _, group := range defaults.CapabilityKeywords {
		for _, keyword := range group.Keywords {
			if strings.Contains(lower, keyword) {
				return group.Capability
			}
		}
	}
	return "text"
}

// SavedModel is the part of one saved model the protocol decision reads.
type SavedModel struct {
	Model           string
	Capability      string
	Protocol        string
	ProtocolPending bool
}

// SavedChannel is the part of one saved channel the protocol decision reads.
type SavedChannel struct {
	Scope         string
	APIFormat     string
	InterfaceType string
}

// SavedModelProtocol mirrors savedProtocolDecision on the web: the protocol a
// saved model is executed with, or "" when it has none. An explicit protocol
// wins; a model the host deliberately left unconfigured (protocolPending) has
// none; then the channel's protocol; then the legacy default that a profile
// without the field has always meant on an OpenAI-compatible user channel.
func SavedModelProtocol(channel SavedChannel, saved SavedModel) string {
	if protocol := strings.TrimSpace(saved.Protocol); protocol != "" {
		return protocol
	}
	if saved.ProtocolPending {
		return ""
	}
	if protocol := strings.TrimSpace(channel.InterfaceType); protocol != "" {
		return protocol
	}
	if strings.TrimSpace(channel.Scope) == "system" {
		return ""
	}
	switch strings.TrimSpace(channel.APIFormat) {
	case "gemini", "claude":
		return ""
	}
	capability := strings.TrimSpace(saved.Capability)
	if capability == "" {
		capability = InferModelCapability(saved.Model)
	}
	return LegacyDefaultProtocol(capability)
}
