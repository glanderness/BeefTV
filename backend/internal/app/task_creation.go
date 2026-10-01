package app

import (
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

const retiredAgentBoundaryMessage = localtask.RetiredAgentBoundaryMessage

// CreateTask 把应用层请求交给任务域。模型目录、密钥和配额仍通过 typed ports 留在 app。
func (s *Service) CreateTask(userID string, req CreateTaskRequest) (*model.Task, error) {
	return s.taskDomain().CreateTask(userID, toTaskCreateRequest(req))
}

// resolveTaskModelSelection 根据请求实际携带的模型选择决定路由方式。
// 显式系统渠道和用户自定义渠道请求不能被全局前台模型开关误判；
// 它们仍分别进入系统目录校验或自定义渠道的功能、能力与安全校验。
func (s *Service) resolveTaskModelSelection(input map[string]any, logicalModelID string, taskType string, operation string, frontendEnabled bool) (*RoutedModel, map[string]any, error) {
	customChannelTask := taskInputUsesCustomChannel(input)
	if frontendEnabled && !taskInputUsesSystemChannel(input) && !customChannelTask {
		if logicalModelID == "" {
			return nil, input, InvalidModelSelection("前台模型模式下必须指定 logicalModelId")
		}
		intent := ModelRequestIntentFromTaskInput(input, taskType, operation)
		routed, err := s.ResolveLogicalModel(logicalModelID, intent)
		if err != nil {
			return nil, input, err
		}
		return routed, applyRoutedProviderSelection(input, routed), nil
	}

	if logicalModelID != "" {
		return nil, input, ModelCatalogMismatch("模型目录已更新，请重新选择")
	}
	// 自定义渠道没有系统 channelId；它会在后续由自定义渠道功能开关、
	// 能力校验和 provider 配置校验共同处理，不能误报为“缺少系统渠道”。
	if !customChannelTask {
		resolvedInput, err := s.resolveSystemChannelModelSelection(input, taskType, operation)
		if err != nil {
			return nil, input, err
		}
		return nil, resolvedInput, nil
	}
	return nil, input, nil
}

func (s *Service) requireCustomChannelsForTaskInput(input map[string]any) error {
	if !taskInputUsesCustomChannel(input) {
		return nil
	}
	return s.RequireFeature(FeatureCustomChannels)
}

// resolveSystemChannelModelSelection 是系统渠道任务的 admission 边界。
// 客户端只负责表达创作参数；模型协议、能力合同、执行规格和上游模型标识必须从服务端记录重建，
// 避免出现“按一个规格校验，却按另一个规格执行”的跨阶段漂移。
func (s *Service) resolveSystemChannelModelSelection(input map[string]any, taskType string, operation string) (map[string]any, error) {
	config, ok := input["config"].(map[string]any)
	if !ok {
		return input, InvalidModelSelection("缺少模型配置")
	}

	channelID := strings.TrimSpace(stringValue(config["channelId"]))
	modelKey := strings.TrimPrefix(strings.TrimSpace(stringValue(config["model"])), "models/")

	if channelID == "" || modelKey == "" {
		return input, InvalidModelSelection("必须指定系统渠道和模型")
	}

	channel, err := s.repo.SystemChannel(channelID)
	if err != nil {
		return input, InvalidModelSelection("指定的渠道不存在")
	}
	if !channel.Enabled || channel.Scope != model.ChannelScopeSystem {
		return input, InvalidModelSelection("指定的渠道不可用")
	}

	channelModel, err := s.repo.ChannelModelByKey(channelID, modelKey)
	if err != nil {
		return input, InvalidModelSelection("指定的模型不存在")
	}
	if !channelModel.Enabled {
		return input, InvalidModelSelection("指定的模型已停用")
	}
	if channelModel.Protocol == "" {
		return input, InvalidModelSelection("指定的模型未配置请求协议")
	}

	nextConfig := make(map[string]any, len(config)+6)
	for key, value := range config {
		switch key {
		case "channelId", "channelModelKey", "variantId", "providerModelKey", "apiFormat", "interfaceType", "baseUrl", "apiKey", "secretKey", "headers", "model", "capabilityConfig":
			continue
		default:
			nextConfig[key] = value
		}
	}
	// capabilityOptions 是路由、校验和计价共同使用的请求规格；存在时必须覆盖 config 中的同名字段，
	// 不能让两份客户端数据分别驱动选型与真实上游请求。
	if options, ok := input["capabilityOptions"].(map[string]any); ok {
		for key, value := range options {
			canonical := canonicalCapabilityOptionName(key)
			if isCapabilityOptionFor(channelModel.Capability, canonical) {
				nextConfig[canonical] = value
			}
		}
	}

	capabilityConfig, err := normalizedChannelModelCapability(channelModel)
	if err != nil {
		return input, InvalidModelSelection("指定的模型能力配置无效，请联系管理员")
	}
	// 只有真实能力配置声明过的参数才能进入路由意图。客户端 config 可能保留
	// 旧模型的质量/分辨率值；若直接重新汇总，会把已关闭的参数误报为“不支持”。
	var capabilitySpec *CapabilitySpec
	if normalizeCapability(channelModel.Capability) != "audio" {
		spec, specErr := CapabilitySpecFromModelCapabilityConfig(capabilityConfig, channelModel.Capability)
		if specErr != nil {
			return input, InvalidModelSelection("指定的模型能力配置无效，请联系管理员")
		}
		capabilitySpec = &spec
	}
	applyChannelCapabilityDefaults(nextConfig, channelModel.Capability, capabilityConfig)
	input["config"] = nextConfig
	var declaredOptions map[string]OptionConstraint
	if capabilitySpec != nil {
		declaredOptions = capabilitySpec.Options
	}
	input["capabilityOptions"] = capabilityOptionsFromConfig(channelModel.Capability, nextConfig, declaredOptions)

	intent := ModelRequestIntentFromTaskInput(input, taskType, operation)
	if normalizeCapability(intent.Capability) != normalizeCapability(channelModel.Capability) {
		return input, ModelCapabilityNotSupported("所选模型与任务能力不匹配")
	}
	if normalizeCapability(channelModel.Capability) != "audio" {
		if capabilitySpec == nil {
			return input, InvalidModelSelection("指定的模型能力配置无效，请联系管理员")
		}
		if match := MatchCapability(*capabilitySpec, intent); !match.Matched {
			return input, ModelCapabilityNotSupported("所选模型不支持当前请求：" + strings.Join(match.Reasons, "；"))
		}
	}

	variantIntent := intent
	if normalizeCapability(channelModel.Capability) == "image" {
		variantOptions := make(map[string]any, len(intent.Options)+2)
		for k, v := range intent.Options {
			variantOptions[k] = v
		}
		rawQuality := strings.ToLower(strings.TrimSpace(fmt.Sprint(nextConfig["quality"])))
		if rawQuality != "" && rawQuality != "<nil>" && rawQuality != "auto" && rawQuality != "any" {
			variantOptions["quality"] = rawQuality
		} else if variantOptions["quality"] == nil || variantOptions["quality"] == "" || variantOptions["quality"] == "auto" {
			variantOptions["quality"] = "1k"
		}
		if rawSize := strings.ToLower(strings.TrimSpace(fmt.Sprint(nextConfig["size"]))); rawSize != "" && rawSize != "<nil>" && rawSize != "auto" {
			variantOptions["size"] = rawSize
		}
		variantIntent.Options = variantOptions
	}

	variant := channelModelVariantForIntent(*channelModel, variantIntent)
	if variant == nil {
		variant = channelModelVariantForIntent(*channelModel, intent)
	}
	if len(channelModel.Variants) > 0 && variant == nil {
		return input, ModelCapabilityNotSupported("指定的模型不支持当前规格")
	}

	nextConfig["channelId"] = channel.ID
	nextConfig["model"] = channelModel.ModelKey
	nextConfig["channelModelKey"] = channelModel.ModelKey
	if variant != nil {
		nextConfig["variantId"] = variant.ID
		nextConfig["providerModelKey"] = firstNonEmpty(variant.ProviderModelKey, channelModel.ProviderModelKey, channelModel.ModelKey)
	} else {
		delete(nextConfig, "variantId")
		nextConfig["providerModelKey"] = firstNonEmpty(channelModel.ProviderModelKey, channelModel.ModelKey)
	}
	nextConfig["interfaceType"] = string(channelModel.Protocol)
	nextConfig["apiFormat"] = channelAPIFormatForProtocol(channel.APIFormat, channelModel.Protocol)
	return input, nil
}

// applyChannelCapabilityDefaults 只采用管理员保存的能力默认值，且仅填补客户端未表达的参数。
// 这些值随后会写回 capabilityOptions，使能力校验、SKU 选择和 provider 执行看到同一份规格。
func applyChannelCapabilityDefaults(config map[string]any, capability string, profile *ModelCapabilityConfig) {
	setDefault := func(key string, value any) {
		if existing, exists := config[key]; !exists || existing == nil || strings.TrimSpace(fmt.Sprint(existing)) == "" {
			// providerConfig uses string-valued controls, including booleans and counts.
			config[key] = fmt.Sprint(value)
		}
	}
	switch normalizeCapability(capability) {
	case "image":
		if profile == nil || profile.Image == nil {
			return
		}
		if profile.Image.Size.Parameter != "none" {
			setDefault("size", profile.Image.Size.Default)
		}
		if profile.Image.Quality.Supported {
			setDefault("quality", profile.Image.Quality.Default)
		}
		setDefault("transparentBackground", profile.Image.TransparentBackground.Default)
		setDefault("count", 1)
	case "video":
		if profile == nil || profile.Video == nil {
			return
		}
		if videoDurationSupported(profile.Video) {
			setDefault("videoSeconds", profile.Video.Duration.Default)
		}
		setDefault("size", profile.Video.DefaultRatio)
		setDefault("vquality", profile.Video.DefaultResolution)
		setDefault("videoGenerateAudio", profile.Video.GenerateAudio.Default)
		setDefault("videoWatermark", profile.Video.Watermark.Default)
	}
}

func capabilityOptionsFromConfig(capability string, config map[string]any, declared map[string]OptionConstraint) map[string]any {
	options := map[string]any{}
	for key, value := range config {
		canonical := canonicalCapabilityOptionName(key)
		if !isCapabilityOptionFor(capability, canonical) || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
			continue
		}
		if declared != nil {
			if _, ok := declared[canonical]; !ok {
				continue
			}
		}
		options[canonical] = value
	}
	return options
}

func taskInputUsesCustomChannel(input map[string]any) bool {
	if taskInputUsesWorkflowProvider(input) {
		return false
	}
	config, ok := input["config"].(map[string]any)
	if !ok {
		return false
	}
	channelID, _ := config["channelId"].(string)
	baseURL, _ := config["baseUrl"].(string)
	apiKey, _ := config["apiKey"].(string)
	credentialRef, _ := config["credentialRef"].(string)
	if strings.EqualFold(strings.TrimSpace(credentialRef), managedBeefAPIRef) || strings.TrimSpace(channelID) == "beefapi" {
		return strings.TrimSpace(baseURL) != "" && strings.TrimSpace(apiKey) != ""
	}
	if strings.TrimSpace(channelID) != "" || systemChannelIDFromBaseURL(baseURL) != "" {
		return false
	}
	return strings.TrimSpace(baseURL) != "" && strings.TrimSpace(apiKey) != ""
}

func taskInputUsesSystemChannel(input map[string]any) bool {
	config, ok := input["config"].(map[string]any)
	if !ok {
		return false
	}
	channelID, _ := config["channelId"].(string)
	return strings.TrimSpace(channelID) != ""
}

func taskInputUsesWorkflowProvider(input map[string]any) bool {
	config, ok := input["config"].(map[string]any)
	if !ok {
		return false
	}
	// 系统渠道的 interfaceType 是客户端缓存，不是授权事实；必须先走系统模型 admission，
	// 不能通过伪造工作流协议绕开渠道模型、能力和价格校验。
	if strings.TrimSpace(stringValue(config["channelId"])) != "" {
		return false
	}
	return isWorkflowProviderInterface(strings.TrimSpace(fmt.Sprint(config["interfaceType"])))
}
