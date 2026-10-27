package modelcatalog

import "strings"

// LookupModelPricing 返回当前生效渠道上某个模型已保存的目录单价（没有价格时 false）。
// 只读本地模型配置，不联网；自带 Key 和自定义渠道通常没有价格。
func LookupModelPricing(snapshot AssistantConfigSnapshot, modelKey string) (map[string]any, bool) {
	channelID, modelID := SplitModelKey(modelKey)
	if strings.TrimSpace(modelID) == "" {
		return nil, false
	}
	for _, channel := range snapshot.Channels {
		if !channel.Enabled {
			continue
		}
		if channelID != "" && channel.ID != channelID {
			continue
		}
		if pricing := assistantModelPricing(channel, modelID); len(pricing) > 0 {
			return pricing, true
		}
		if channelID != "" {
			return nil, false
		}
	}
	return nil, false
}

func assistantModelPricing(channel AssistantChannel, modelID string) map[string]any {
	aliased := assistantModelAlias(channel, modelID)
	for _, profile := range channel.ModelProfiles {
		if profile.Model == modelID || profile.Model == aliased {
			return profile.Pricing
		}
	}
	return nil
}
