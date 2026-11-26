package operations

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/pricing"
)

// ServerPricingEstimator calls the authoritative BeefTV pricing estimate API
// when a live BeefTV connection is active. Callers that do not implement it
// fall back to local catalog pricing.
type ServerPricingEstimator interface {
	EstimateServerPricing(ctx context.Context, req beeftv.PricingEstimateRequest) (beeftv.PricingEstimateResponse, error)
}

const serverPricingEstimateTimeout = 3 * time.Second

// EstimateTarget is one planned generation as the canvas would submit it.
type EstimateTarget struct {
	ModelKey        string            `json:"modelKey"`
	Kind            string            `json:"kind"`
	Parameters      map[string]string `json:"parameters,omitempty"`
	ReferenceImages int               `json:"referenceImages,omitempty"`
	ReferenceVideos int               `json:"referenceVideos,omitempty"`
	Text            string            `json:"text,omitempty"`
}

type GenerationEstimate struct {
	Items   []pricing.Estimate `json:"items"`
	Summary pricing.Summary    `json:"summary"`
}

func registerGenerationEstimateOp(r *Registry) {
	r.Register(Op{AssistantCanvas: true, ID: "generation.estimate", Summary: "估算一组生成的费用（官方渠道优先使用服务端估价接口，离线或自建渠道回退到本地目录）；不写入、不建任务，没有价格的项目会写明原因", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"targets":{"type":"array","minItems":1,"items":{"type":"object","properties":{"modelKey":{"type":"string"},"kind":{"type":"string","enum":["image","video","audio"]},"parameters":{"type":"object","additionalProperties":{"type":"string"},"description":"与节点相同的生成参数，如 size、quality、count、vquality、seconds"},"referenceImages":{"type":"integer","minimum":0},"referenceVideos":{"type":"integer","minimum":0},"text":{"type":"string","description":"配音台词"}},"required":["modelKey","kind"]}}},"required":["targets"]}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct {
				Targets []EstimateTarget `json:"targets"`
			}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			if len(args.Targets) == 0 {
				return nil, InvalidArg("invalid_batch", "targets 至少需要 1 项")
			}
			for _, target := range args.Targets {
				if target.Kind != "image" && target.Kind != "video" && target.Kind != "audio" {
					return nil, InvalidArg("invalid_kind", "kind 只能是 image、video 或 audio")
				}
				if target.ReferenceImages < 0 || target.ReferenceVideos < 0 {
					return nil, InvalidArg("invalid_params", "参考素材数量不能为负数")
				}
			}
			return EstimateGenerationCost(ctx.Domain, args.Targets), nil
		}})
}

type preparedEstimateTarget struct {
	channelID string
	shortKey  string
	model     modelcatalog.PublicChannelModel
	found     bool
	request   pricing.Target
}

// EstimateGenerationCost prices planned targets. For official BeefTV channel
// targets it prefers the authoritative server POST /v1/pricing/estimate API
// when available, falling back seamlessly to the saved local catalog when
// offline, unconfigured, or for BYOK channels.
func EstimateGenerationCost(domain Domain, targets []EstimateTarget) GenerationEstimate {
	var catalog *modelcatalog.CatalogResponse
	if reader, ok := domain.(ModelCatalogReader); ok {
		catalog, _ = reader.AgentModelCatalog()
	}
	prepared := make([]preparedEstimateTarget, len(targets))
	serverIndices := make([]int, 0, len(targets))
	serverTargets := make([]beeftv.PricingEstimateTarget, 0, len(targets))
	for i, target := range targets {
		item := prepareEstimateTarget(catalog, target)
		prepared[i] = item
		managedBeefTV := item.channelID == beeftv.ChannelID
		if item.found && item.model.ManagedBeefTV != nil {
			managedBeefTV = *item.model.ManagedBeefTV
		}
		if managedBeefTV && item.shortKey != "" && (catalog == nil || item.found) {
			modelKey := item.shortKey
			if item.found && strings.TrimSpace(item.model.ModelKey) != "" {
				_, key := splitEstimateModelKey(item.model.ModelKey)
				if key != "" {
					modelKey = key
				}
			}
			serverIndices = append(serverIndices, i)
			serverTargets = append(serverTargets, beeftv.PricingEstimateTarget{
				Model:           modelKey,
				Kind:            item.request.Kind,
				Size:            item.request.Size,
				Quality:         item.request.Quality,
				Layers:          item.request.Layers,
				Count:           max(item.request.Count, 1),
				ReferenceImages: item.request.ReferenceImages,
				ReferenceVideos: item.request.ReferenceVideos,
				Resolution:      item.request.Resolution,
				Seconds:         item.request.Seconds,
				Characters:      item.request.Characters,
			})
		}
	}

	items := make([]pricing.Estimate, len(targets))
	pricedByServer := make([]bool, len(targets))
	var serverSummary *pricing.Summary
	if len(serverTargets) > 0 {
		if estimator, ok := domain.(ServerPricingEstimator); ok && estimator != nil {
			ctx, cancel := context.WithTimeout(context.Background(), serverPricingEstimateTimeout)
			resp, err := estimator.EstimateServerPricing(ctx, beeftv.PricingEstimateRequest{Targets: serverTargets})
			cancel()
			if err == nil && len(resp.Items) == len(serverIndices) {
				for j, idx := range serverIndices {
					items[idx] = resp.Items[j]
					pricedByServer[idx] = true
				}
				if len(serverIndices) == len(targets) && strings.TrimSpace(resp.Summary.Text) != "" && resp.Summary.Priced+resp.Summary.Unknown == len(targets) {
					summary := resp.Summary
					serverSummary = &summary
				}
			}
		}
	}

	for i, item := range prepared {
		if pricedByServer[i] {
			continue
		}
		items[i] = estimatePreparedTarget(item)
	}
	if serverSummary != nil {
		return GenerationEstimate{Items: items, Summary: *serverSummary}
	}
	return GenerationEstimate{Items: items, Summary: pricing.Summarize(items)}
}

func prepareEstimateTarget(catalog *modelcatalog.CatalogResponse, target EstimateTarget) preparedEstimateTarget {
	channelID, shortKey := splitEstimateModelKey(target.ModelKey)
	foundChannelID, model, found := findEstimateModel(catalog, target.ModelKey)
	if found {
		channelID = foundChannelID
	}
	params := target.Parameters
	count, _ := strconv.Atoi(strings.TrimSpace(params["count"]))
	request := pricing.Target{Kind: target.Kind, Count: count, ReferenceImages: target.ReferenceImages, ReferenceVideos: target.ReferenceVideos}
	capability := estimateCapability(model.CapabilityConfig)
	switch target.Kind {
	case "image":
		var image *modelcatalog.ImageCapabilityConfig
		if capability != nil {
			image = capability.Image
		}
		request.Size, request.Quality = generation.ManagedImageSizeAndQuality(image, params["size"], params["quality"])
		request.Layers = params["seedreamMode"] == "layers"
		// A group request bills each returned image, up to this many.
		if outputs := generation.SequentialMaxImages(params["seedreamMaxImages"], target.ReferenceImages); outputs > 1 && (image == nil || image.SequentialGeneration.Supported) {
			request.Count = outputs
		}
	case "video":
		resolution, seconds := params["vquality"], params["seconds"]
		if capability != nil && capability.Video != nil {
			if strings.TrimSpace(resolution) == "" {
				resolution = capability.Video.DefaultResolution
			}
			if strings.TrimSpace(seconds) == "" && capability.Video.Duration.Default > 0 {
				seconds = strconv.Itoa(capability.Video.Duration.Default)
			}
		}
		request.Resolution = strings.TrimSpace(resolution)
		request.Seconds, _ = strconv.ParseFloat(strings.TrimSpace(seconds), 64)
	case "audio":
		request.Characters = utf8.RuneCountInString(strings.TrimSpace(target.Text))
	}
	return preparedEstimateTarget{
		channelID: channelID,
		shortKey:  shortKey,
		model:     model,
		found:     found,
		request:   request,
	}
}

func estimatePreparedTarget(item preparedEstimateTarget) pricing.Estimate {
	if !item.found {
		return pricing.Unknown("找不到这个模型，暂无价格")
	}
	table := item.model.Pricing
	if table == nil && item.request.Kind == "video" {
		table = pricing.FromVideoQuote(item.model.VideoPricing)
	}
	if table == nil {
		if item.channelID != beeftv.ChannelID {
			return pricing.Unknown("自带 Key 的渠道暂无价格，按该渠道实际计费")
		}
		return pricing.Unknown("这个模型暂无价格")
	}
	return pricing.Quote(table, item.request)
}

func splitEstimateModelKey(modelKey string) (string, string) {
	channelID, shortKey := "", strings.TrimSpace(modelKey)
	if i := strings.Index(shortKey, "::"); i >= 0 {
		channelID, shortKey = strings.TrimSpace(shortKey[:i]), strings.TrimSpace(shortKey[i+2:])
	}
	return channelID, shortKey
}

func findEstimateModel(catalog *modelcatalog.CatalogResponse, modelKey string) (string, modelcatalog.PublicChannelModel, bool) {
	if catalog == nil {
		return "", modelcatalog.PublicChannelModel{}, false
	}
	channelID, shortKey := splitEstimateModelKey(modelKey)
	if channelID == "" || shortKey == "" {
		return "", modelcatalog.PublicChannelModel{}, false
	}
	for _, channel := range catalog.Channels {
		if channel.ID != channelID {
			continue
		}
		for _, model := range channel.Models {
			if model.ModelKey == shortKey || model.ID == shortKey {
				return channel.ID, model, true
			}
		}
	}
	return "", modelcatalog.PublicChannelModel{}, false
}

func estimateCapability(config map[string]any) *modelcatalog.ModelCapabilityConfig {
	if len(config) == 0 {
		return nil
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return nil
	}
	value, err := modelcatalog.DecodeModelCapabilityConfig(string(raw))
	if err != nil {
		return nil
	}
	return value
}

type estimatedGenerationTarget struct {
	GenerationTarget
	Estimate pricing.Estimate `json:"estimate"`
}

// estimateGenerationTargets describes canvas targets for the estimate. A
// reference counts as a video when its node generates video.
func estimateGenerationTargets(nodes map[string]map[string]any, targets []GenerationTarget) []EstimateTarget {
	result := make([]EstimateTarget, 0, len(targets))
	for _, target := range targets {
		item := EstimateTarget{ModelKey: target.ModelKey, Kind: target.Kind, Parameters: target.Parameters}
		for _, id := range target.ReferenceNodeIDs {
			switch nodeGenerationKind(nodes[id]) {
			case "video":
				item.ReferenceVideos++
			case "audio":
			default:
				item.ReferenceImages++
			}
		}
		if target.Kind == "audio" {
			item.Text = target.Prompt
		}
		result = append(result, item)
	}
	return result
}
