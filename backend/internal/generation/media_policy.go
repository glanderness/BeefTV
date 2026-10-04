package generation

import (
	"context"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/providerpreset"
)

func MediaHydrationPolicyFor(ctx context.Context, input Input) MediaHydrationPolicy {
	if input.Config.InterfaceType == "full-video" {
		return MediaHydrationPolicy{KeepLocal: true}
	}
	policy := MediaHydrationPolicy{PreferURL: PrefersMediaURLs(input.Config.InterfaceType, input)}
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		return MediaHydrationPolicy{PreferHTTPS: true}
	}
	if IsBeefAPIVideoConfig(ctx, input.Config) {
		if contract, ok := providerpreset.BeefAPIVideoContract(input.Config.Model); ok && contract.InlineMedia && (contract.Protocol == input.Config.InterfaceType || IsSeedanceVideoConfig(input.Config)) {
			return MediaHydrationPolicy{PreferHTTPS: true, KeepLocal: IsBeefAPISeedancePreuploadConfig(ctx, input.Config)}
		}
	}
	if strings.TrimSpace(input.Config.InterfaceType) == string(model.ChannelInterfaceNewAPIChannel1) {
		policy.RequireURL = false
		policy.PreferURL = false
		return policy
	}
	switch strings.TrimSpace(input.Config.InterfaceType) {
	case string(model.ChannelInterfaceNewAPIVideo), string(model.ChannelInterfaceNewAPIChannel1), string(model.ChannelInterfaceNewAPIChannel2), string(model.ChannelInterfaceVolcengineArkVideo), string(model.ChannelInterfaceVolcengineArkAgentPlanVideo), string(model.ChannelInterfaceMiniMaxVideo):
		policy.RequireURL = true
		policy.PreferURL = true
	}
	if adapter, ok := ProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		policy.RequireURL = adapter.Metadata().RequiresPublicMediaURLs
		policy.PreferURL = policy.PreferURL || policy.RequireURL
	}
	if input.Mode == "image" && input.Mask != nil {
		policy.RequireURL = false
		policy.PreferURL = false
	}
	return policy
}

// PrefersMediaURLs lists protocols that accept remote URLs. Multipart/byte
// protocols keep the byte path so a smaller download cannot change the request.
func PrefersMediaURLs(interfaceType string, input Input) bool {
	if input.Mode == "image" && input.Mask != nil {
		return false
	}
	switch strings.TrimSpace(interfaceType) {
	case string(model.ChannelInterfaceChatCompletion), string(model.ChannelInterfaceOpenAIResponse), string(model.ChannelInterfaceClaudeAPI),
		string(model.ChannelInterfaceGrokImage), string(model.ChannelInterfaceVolcengineArkImage), string(model.ChannelInterfaceVolcengineArkAgentPlanImage),
		string(model.ChannelInterfaceXAIVideo), string(model.ChannelInterfaceNovitaVideo),
		string(model.ChannelInterfaceMiniMaxVideo), string(model.ChannelInterfaceNewAPIVideo),
		string(model.ChannelInterfaceNewAPIChannel1), string(model.ChannelInterfaceNewAPIChannel2),
		string(model.ChannelInterfaceVolcengineArkVideo), string(model.ChannelInterfaceVolcengineArkAgentPlanVideo):
		return true
	}
	if IsGrokVideoConfig(input.Config) || IsSeedanceVideoConfig(input.Config) || IsArkPlanVideoConfig(input.Config) {
		return true
	}
	return false
}
