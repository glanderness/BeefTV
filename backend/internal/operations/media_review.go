package operations

import (
	"context"
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// MediaReviewer performs one bounded inference over bytes already authorized by
// the media operation. It has no tools, project writes, or recovery loop.
type MediaReviewer interface {
	ReviewMedia(context.Context, MediaPart, string) (MediaReviewObservation, error)
}

type MediaReviewObservation struct {
	Model     string          `json:"model"`
	RequestID string          `json:"requestId,omitempty"`
	Text      string          `json:"observations"`
	Usage     json.RawMessage `json:"usage,omitempty"`
}

type mediaReviewArgs struct {
	CanvasID        string `json:"canvasId"`
	NodeID          string `json:"nodeId,omitempty"`
	AssetID         string `json:"assetId,omitempty"`
	ResourceID      string `json:"resourceId,omitempty"`
	ExpectedVersion string `json:"expectedVersion"`
	StartMs         int64  `json:"startMs"`
	EndMs           int64  `json:"endMs"`
	Mode            string `json:"mode,omitempty"`
	Question        string `json:"question"`
}

func registerMediaReview(r *Registry) {
	r.Register(Op{ID: "media.review", AssistantCanvas: true, ReadOnly: true, ReplayUnsafe: true, Scope: ScopeCanvas,
		Summary: "独立多模态审片（可能收费，≤15秒）",
		Params:  json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"assetId":{"type":"string"},"resourceId":{"type":"string"},"expectedVersion":{"type":"string"},"startMs":{"type":"integer"},"endMs":{"type":"integer"},"mode":{"type":"string","enum":["video","audio","image"]},"question":{"type":"string"}},"required":["canvasId","expectedVersion","startMs","endMs","question"]}`), Handler: runMediaReview})
}

func runMediaReview(ctx *Context, raw json.RawMessage) (any, error) {
	var args mediaReviewArgs
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if args.Mode == "" {
		args.Mode = "video"
	}
	if args.Mode != "video" && args.Mode != "audio" && args.Mode != "image" {
		return nil, InvalidArg("invalid_media_mode", "mode 必须是 video、audio 或 image")
	}
	if strings.TrimSpace(args.Question) == "" || len([]rune(args.Question)) > 4000 || strings.TrimSpace(args.ExpectedVersion) == "" {
		return nil, InvalidArg("invalid_media_review", "请提供素材版本和审查问题")
	}
	if args.Mode == "image" {
		if args.StartMs != 0 || args.EndMs != 0 {
			return nil, InvalidArg("invalid_media_review", "图片审片必须传 startMs=0、endMs=0")
		}
	} else if args.StartMs < 0 || args.EndMs <= args.StartMs || args.EndMs-args.StartMs > 15000 {
		return nil, InvalidArg("invalid_media_review", "请提供素材版本、明确的15秒以内区间和审查问题")
	}
	reviewer, ok := ctx.Domain.(MediaReviewer)
	if !ok {
		return nil, Unsupported("media_review_unavailable", "当前工作区未配置审片模型")
	}
	inspectMode := args.Mode
	if args.Mode == "image" {
		inspectMode = "frames"
	}
	params, _ := json.Marshal(mediaArgs{CanvasID: args.CanvasID, NodeID: args.NodeID, AssetID: args.AssetID, ResourceID: args.ResourceID, ExpectedVersion: args.ExpectedVersion, StartMs: args.StartMs, EndMs: args.EndMs, Mode: inspectMode})
	value, err := runMedia(ctx, "media.inspect", params)
	if err != nil {
		return nil, err
	}
	media := value.(MediaResult)
	var part MediaPart
	switch args.Mode {
	case "image":
		if media.Image == nil || len(media.Content) != 1 || !strings.HasPrefix(media.Content[0].MimeType, "image/") {
			return nil, InvalidArg("media_review_requires_image", "图片审片工具需要图片素材")
		}
		part = media.Content[0]
	case "audio":
		if len(media.Content) != 1 || media.Content[0].MimeType != "audio/wav" {
			return nil, InvalidArg("media_review_requires_audio", "审片工具需要音频素材")
		}
		part = media.Content[0]
	default:
		if len(media.Content) != 1 || media.Content[0].MimeType != "video/mp4" {
			return nil, InvalidArg("media_review_requires_video", "审片工具需要视频素材")
		}
		part = media.Content[0]
	}
	var permit *paidSyncPermit
	if ctx.Caller.Kind == CallerAssistant && ctx.DB() != nil && (strings.TrimSpace(ctx.TurnID) != "" || HasAnyMandateInTx(ctx.DB(), ctx.UserID, args.CanvasID, "")) {
		var permitErr error
		digest := mediaReviewTargetDigest(args.CanvasID, args.NodeID, args.AssetID, args.ResourceID, args.Mode, args.StartMs, args.EndMs)
		permit, permitErr = acquirePaidSyncPermit(ctx, args.CanvasID, model.MandateKindMediaReview, "media.review", digest)
		if permitErr != nil {
			return nil, permitErr
		}
	}
	observation, err := reviewer.ReviewMedia(ctx.Context, part, args.Question)
	if err != nil {
		if permit != nil {
			permit.Release()
		}
		return nil, err
	}
	if permit != nil {
		permit.Settle("")
	}
	note := "指定片段已交给审片模型；观察可能有遗漏，需与原始要求及可见画面对照。时间位置以截取片段起点为0，加上source.startMs后才是原素材位置。"
	switch args.Mode {
	case "audio":
		note = "指定音频片段已交给审片模型；观察可能有遗漏，需与原始要求及实际声音对照，不表示主模型亲自听取。时间位置以截取片段起点为0，加上source.startMs后才是原素材位置。"
	case "image":
		note = "指定图片已交给审片模型；观察可能有遗漏，需与原始要求及可见画面对照。"
	}
	return map[string]any{"source": media.Source, "durationMs": media.DurationMs, "hasAudio": media.HasAudio, "mediaSHA256": part.SHA256, "review": observation, "note": note}, nil
}
