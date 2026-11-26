package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/creativebible"
)

func registerCreativeBibleOps(r *Registry) {
	r.Register(Op{
		AssistantCanvas: true,
		ReadOnly:        true,
		ReplaySafe:      true,
		ID:              "project.bible.get",
		Summary:         "读取当前项目或画布共享的创作设定集（角色外观、画风、色彩、场景、镜头规范与创作禁忌）",
		Scope:           ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"canvasId":{"type":"string","description":"当前画布 ID（自动解析所属项目的共享设定集）"},` +
			`"projectId":{"type":"string","description":"可选项目 ID（未传 canvasId 时使用）"}` +
			`}}`),
		Handler: opCreativeBibleGet,
	})
	r.Register(Op{
		AssistantCanvas: true,
		ReplaySafe:      true,
		ID:              "project.bible.update",
		Summary:         "创建或局部更新当前项目/画布的创作设定集（支持 expectedRevision 防覆盖；内置助手与外部 MCP 共享）",
		Scope:           ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"canvasId":{"type":"string","description":"当前画布 ID（自动写入所属项目的共享设定集）"},` +
			`"projectId":{"type":"string","description":"可选项目 ID（未传 canvasId 时使用）"},` +
			`"expectedRevision":{"type":"integer","minimum":0,"description":"期望版本号，首次写入可传 0"},` +
			`"title":{"type":"string"},` +
			`"logline":{"type":"string"},` +
			`"visualStyle":{"type":"string"},` +
			`"colorPalette":{"type":"string"},` +
			`"cameraRules":{"type":"string"},` +
			`"taboos":{"type":"string"},` +
			`"characters":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"},"appearance":{"type":"string"},"wardrobe":{"type":"string"},"voice":{"type":"string"},"notes":{"type":"string"},"referenceAssetId":{"type":"string"}},"required":["name"]}},` +
			`"locations":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"lighting":{"type":"string"},"notes":{"type":"string"},"referenceAssetId":{"type":"string"}},"required":["name"]}}` +
			`}}`),
		Handler: opCreativeBibleUpdate,
	})
}

func resolveBibleScopeFromOp(ctx *Context, canvasID, projectID string) (string, string, error) {
	db := ctx.DB()
	if db == nil {
		return "", "", Unsupported("bible_unavailable", "当前工作区暂不支持创作设定集")
	}
	cleanCanvas := strings.TrimSpace(canvasID)
	cleanProject := strings.TrimSpace(projectID)
	if cleanCanvas != "" {
		// Verify canvas ownership through Domain (respects assistant turn scope too).
		if _, err := ctx.Domain.UserCanvasProject(ctx.UserID, cleanCanvas); err != nil {
			return "", "", mapDomainError(err)
		}
		scopeKind, scopeID, err := creativebible.ResolveScopeForCanvas(db, ctx.UserID, cleanCanvas)
		if err != nil {
			return "", "", mapDomainError(err)
		}
		return scopeKind, scopeID, nil
	}
	if cleanProject != "" {
		if err := creativebible.VerifyProjectOwnership(db, ctx.UserID, cleanProject); err != nil {
			return "", "", mapDomainError(err)
		}
		return creativebible.ScopeProject, cleanProject, nil
	}
	return "", "", InvalidArg("invalid_params", "canvasId 或 projectId 至少填写一项")
}

func opCreativeBibleGet(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID  string `json:"canvasId"`
		ProjectID string `json:"projectId"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	scopeKind, scopeID, err := resolveBibleScopeFromOp(ctx, args.CanvasID, args.ProjectID)
	if err != nil {
		return nil, err
	}
	bible, err := creativebible.Get(ctx.DB(), ctx.UserID, scopeKind, scopeID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"bible":  bible,
		"digest": creativebible.FormatDigest(bible),
		"empty":  bible.IsEmpty(),
	}, nil
}

func opCreativeBibleUpdate(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                          `json:"canvasId"`
		ProjectID        string                          `json:"projectId"`
		ExpectedRevision *int64                          `json:"expectedRevision"`
		Title            *string                         `json:"title"`
		Logline          *string                         `json:"logline"`
		VisualStyle      *string                         `json:"visualStyle"`
		ColorPalette     *string                         `json:"colorPalette"`
		CameraRules      *string                         `json:"cameraRules"`
		Taboos           *string                         `json:"taboos"`
		Characters       *[]creativebible.CharacterEntry `json:"characters"`
		Locations        *[]creativebible.LocationEntry  `json:"locations"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	scopeKind, scopeID, err := resolveBibleScopeFromOp(ctx, args.CanvasID, args.ProjectID)
	if err != nil {
		return nil, err
	}
	saved, err := creativebible.Save(ctx.DB(), ctx.UserID, scopeKind, scopeID, creativebible.UpdateInput{
		ExpectedRevision: args.ExpectedRevision,
		Title:            args.Title,
		Logline:          args.Logline,
		VisualStyle:      args.VisualStyle,
		ColorPalette:     args.ColorPalette,
		CameraRules:      args.CameraRules,
		Taboos:           args.Taboos,
		Characters:       args.Characters,
		Locations:        args.Locations,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"bible":  saved,
		"digest": creativebible.FormatDigest(saved),
		"empty":  saved.IsEmpty(),
	}, nil
}

// creativeBibleDigestForCanvas returns a compact digest string when the canvas
// (or its owning project) has a non-empty Creative Bible, or "" otherwise.
func creativeBibleDigestForCanvas(ctx *Context, canvasID string) string {
	db := ctx.DB()
	if db == nil {
		return ""
	}
	scopeKind, scopeID, err := creativebible.ResolveScopeForCanvas(db, ctx.UserID, canvasID)
	if err != nil {
		return ""
	}
	bible, err := creativebible.Get(db, ctx.UserID, scopeKind, scopeID)
	if err != nil {
		return ""
	}
	return creativebible.FormatDigest(bible)
}
