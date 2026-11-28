package operations

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/transcription"
)

// MediaTranscriptionClientResolver resolves a transcription.Client for either
// free local Whisper (modelID == "") or paid cloud Whisper (modelID != "").
type MediaTranscriptionClientResolver interface {
	ResolveMediaTranscriptionClient(ctx context.Context, modelID string) (*transcription.Client, error)
}

type mediaTranscribeArgs struct {
	CanvasID   string `json:"canvasId"`
	NodeID     string `json:"nodeId,omitempty"`
	AssetID    string `json:"assetId,omitempty"`
	ResourceID string `json:"resourceId,omitempty"`
	Language   string `json:"language,omitempty"`
	Model      string `json:"model,omitempty"`
}

type mediaTranscribeOpener struct {
	opener   MediaSourceOpener
	userID   string
	mimeType string
}

func (o mediaTranscribeOpener) Open(ctx context.Context, resourceID string) (transcription.Media, io.ReadCloser, error) {
	reader, err := o.opener.OpenMediaResource(ctx, o.userID, resourceID)
	if err != nil {
		return transcription.Media{}, nil, err
	}
	return transcription.Media{MimeType: o.mimeType}, reader, nil
}

func registerMediaTranscribe(r *Registry) {
	r.Register(Op{
		ID:              "media.transcribe",
		AssistantCanvas: true,
		ReadOnly:        true,
		ReplayUnsafe:    true,
		Scope:           ScopeCanvas,
		Summary:         "把音视频转写为带时间戳的字幕与 SRT（省略 model 走本地免费 Whisper；指定 model 走云端付费转写，须预算包或用户批准）",
		Params: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{` +
			`"canvasId":{"type":"string"},` +
			`"nodeId":{"type":"string"},` +
			`"assetId":{"type":"string"},` +
			`"resourceId":{"type":"string"},` +
			`"language":{"type":"string","description":"可选 ISO 语言码，如 zh、en；省略自动识别"},` +
			`"model":{"type":"string","description":"可选云端转写模型；省略使用本地免费 whisper.cpp，指定则走付费云端转写"}` +
			`},"required":["canvasId"]}`),
		Handler: runMediaTranscribe,
	})
}

func resolveTranscriptionClientForOp(ctx *Context, modelID string) (*transcription.Client, error) {
	if resolver, ok := ctx.Domain.(MediaTranscriptionClientResolver); ok {
		client, err := resolver.ResolveMediaTranscriptionClient(ctx.Context, modelID)
		if err != nil {
			return nil, PreconditionFailed("media_transcribe_unavailable", err.Error(), nil)
		}
		if client == nil {
			return nil, PreconditionFailed("media_transcribe_unavailable", "转写服务未配置", nil)
		}
		return client, nil
	}
	if modelID != "" {
		return nil, Unsupported("media_transcribe_unavailable", "当前工作区不支持云端语音转写")
	}
	baseURL := strings.TrimSpace(os.Getenv(transcription.BaseURLEnv))
	if baseURL == "" {
		return nil, PreconditionFailed("media_transcribe_unavailable", "未配置本地转写服务：请设置 CANVAS_WHISPER_BASE_URL 指向 whisper.cpp 服务", nil)
	}
	return transcription.NewClient(baseURL), nil
}

func runMediaTranscribe(ctx *Context, raw json.RawMessage) (any, error) {
	var args mediaTranscribeArgs
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	args.Model = strings.TrimSpace(args.Model)
	args.Language = strings.TrimSpace(args.Language)
	if len([]rune(args.Language)) > 32 || len([]rune(args.Model)) > 160 {
		return nil, InvalidArg("invalid_media_transcribe", "转写参数长度超出限制")
	}

	resourceID, err := resolveMediaResource(ctx, mediaArgs{
		CanvasID:   args.CanvasID,
		NodeID:     args.NodeID,
		AssetID:    args.AssetID,
		ResourceID: args.ResourceID,
	})
	if err != nil {
		return nil, err
	}
	resource, err := ctx.Domain.OwnedReadyResource(ctx.UserID, resourceID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if resource == nil || resource.Size > maxMediaSourceBytes {
		return nil, PreconditionFailed("media_too_large", "当前媒体转写支持 256 MiB 以内的素材", nil)
	}
	if !transcription.IsTranscribableMIME(resource.MimeType) {
		return nil, InvalidArg("media_transcribe_unsupported_mime", "仅支持音视频文件转写")
	}
	opener, ok := ctx.Domain.(MediaSourceOpener)
	if !ok {
		return nil, Unsupported("media_unavailable", "当前工作区不支持媒体读取")
	}

	client, err := resolveTranscriptionClientForOp(ctx, args.Model)
	if err != nil {
		return nil, err
	}

	// Billing security: treat ANY non-empty model (requested OR resolved by workspace config)
	// as paid cloud Whisper requiring read-write privilege and atomic ProductionMandate / approval.
	effectiveModel := strings.TrimSpace(client.Model)
	if effectiveModel == "" {
		effectiveModel = args.Model
	}
	isPaidCloud := effectiveModel != ""

	var permit *paidSyncPermit
	if isPaidCloud {
		if ctx.Caller.ReadOnly {
			return nil, newError(CodeReadOnly, "read_only_client", "只读客户端不能调用云端付费语音转写", nil)
		}
		if ctx.Caller.Kind == CallerAssistant {
			if ctx.DB() == nil {
				return nil, PreconditionFailed("approval_required", "云端语音转写需要用户批准或有效制作预算包授权", map[string]any{
					"kind":   model.MandateKindMediaTranscribe,
					"reason": "no_active_mandate",
				})
			}
			digest := mediaTranscribeTargetDigest(args.CanvasID, args.NodeID, args.AssetID, args.ResourceID, effectiveModel)
			var permitErr error
			permit, permitErr = acquirePaidSyncPermit(ctx, args.CanvasID, model.MandateKindMediaTranscribe, "media.transcribe", digest)
			if permitErr != nil {
				return nil, permitErr
			}
		}
	}

	executor := &transcription.Executor{
		Media:  mediaTranscribeOpener{opener: opener, userID: ctx.UserID, mimeType: resource.MimeType},
		Client: client,
	}
	result, runErr := executor.Run(ctx.Context, resourceID, args.Language, nil)
	if runErr != nil {
		if permit != nil {
			permit.Release()
		}
		return nil, PreconditionFailed("media_transcribe_failed", runErr.Error(), nil)
	}
	if permit != nil {
		permit.Settle("")
	}

	mode := "local"
	if isPaidCloud {
		mode = "cloud"
	}
	out := map[string]any{
		"source": MediaSource{
			CanvasID:   args.CanvasID,
			NodeID:     args.NodeID,
			AssetID:    args.AssetID,
			ResourceID: resourceID,
		},
		"mode":     mode,
		"segments": result.Segments,
		"srt":      result.SRT,
		"language": result.Language,
	}
	if effectiveModel != "" {
		out["model"] = effectiveModel
	}
	return out, nil
}
