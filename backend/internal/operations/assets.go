package operations

import (
	"encoding/json"
	"strings"
	"time"
)

// maxAssetTitleRunes 对齐 model.Asset 的 Title 长度约束（size:240）。
const maxAssetTitleRunes = 240

// assetWritableKinds 是外部入口可创建的素材类型：只有不依赖媒体资源的
// 内容型素材可以由 MCP/CLI 直接创建。image/video/audio/model 必须有真实
// 媒体定位符（资源存储的 storageKey/URL），伪造元数据会造出界面与生成
// 链路都无法消费的坏素材——这类素材只能经上传或画布保存进入素材库。
var assetWritableKinds = map[string]struct{}{
	"text":   {},
	"entity": {},
}

// assetCreateArgs 是创建内容型素材的入参；data 部分按 kind 取 content 或 definition。
type assetCreateArgs struct {
	Kind       string         `json:"kind"`
	Title      string         `json:"title"`
	Tags       []string       `json:"tags"`
	Category   string         `json:"category"`
	FolderID   string         `json:"folderId"`
	Note       string         `json:"note"`
	Content    string         `json:"content"`
	Definition map[string]any `json:"definition"`
}

func opAssetCreate(ctx *Context, params json.RawMessage) (any, error) {
	var args assetCreateArgs
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	kind := strings.TrimSpace(args.Kind)
	if _, ok := assetWritableKinds[kind]; !ok {
		return nil, InvalidArg("unsupported_kind",
			"MCP 只能创建 text/entity 内容型素材；图片、视频、音频与模型素材需要真实媒体文件，请通过画布保存或上传入口进入素材库")
	}
	if err := validateAssetTitle(args.Title); err != nil {
		return nil, err
	}
	document, err := buildAssetDocument(kind, args)
	if err != nil {
		return nil, err
	}
	summary, err := ctx.Domain.UpsertUserAsset(ctx.UserID, document)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"assetId": summary.ID, "kind": summary.Kind, "category": summary.Category,
		"title": summary.Title, "createdAt": summary.CreatedAt, "updatedAt": summary.UpdatedAt,
	}, nil
}

func opAssetUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		AssetID  string    `json:"assetId"`
		Title    *string   `json:"title"`
		Tags     *[]string `json:"tags"`
		Favorite *bool     `json:"favorite"`
		Category *string   `json:"category"`
		FolderID *string   `json:"folderId"`
		Note     *string   `json:"note"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.AssetID) == "" {
		return nil, InvalidArg("invalid_params", "assetId 必填")
	}
	if args.Title != nil {
		if err := validateAssetTitle(*args.Title); err != nil {
			return nil, err
		}
	}
	if args.Title == nil && args.Tags == nil && args.Favorite == nil &&
		args.Category == nil && args.FolderID == nil && args.Note == nil {
		return nil, InvalidArg("empty_patch", "patch 至少要有一个字段")
	}
	current, err := ctx.Domain.UserAsset(ctx.UserID, args.AssetID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var document map[string]any
	if err := json.Unmarshal(current, &document); err != nil {
		return nil, AsError(err)
	}
	// 只覆盖白名单元字段；媒体定位符（data）逐字保留，画布引用守卫由领域复检。
	if args.Title != nil {
		document["title"] = *args.Title
	}
	if args.Tags != nil {
		document["tags"] = *args.Tags
	}
	if args.Favorite != nil {
		document["favorite"] = *args.Favorite
	}
	if args.Category != nil {
		document["category"] = *args.Category
	}
	if args.FolderID != nil {
		document["folderId"] = strings.TrimSpace(*args.FolderID)
	}
	if args.Note != nil {
		document["note"] = *args.Note
	}
	document["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, AsError(err)
	}
	summary, err := ctx.Domain.UpsertUserAsset(ctx.UserID, encoded)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"assetId": summary.ID, "kind": summary.Kind, "category": summary.Category,
		"title": summary.Title, "updatedAt": summary.UpdatedAt,
	}, nil
}

// opAssetDelete 删除素材是不可逆写：必须携带素材当前标题做二次确认，
// 标题不匹配即拒绝；素材仍被引用时由资源域引用检查拒绝并返回来源。
func opAssetDelete(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		AssetID       string `json:"assetId"`
		ExpectedTitle string `json:"expectedTitle"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.AssetID) == "" {
		return nil, InvalidArg("invalid_params", "assetId 必填")
	}
	if strings.TrimSpace(args.ExpectedTitle) == "" {
		return nil, InvalidArg("invalid_params", "expectedTitle 必填（须与素材当前标题一致才执行删除）")
	}
	current, err := ctx.Domain.UserAsset(ctx.UserID, args.AssetID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var payload struct {
		Title string `json:"title"`
	}
	if err := json.Unmarshal(current, &payload); err != nil {
		return nil, AsError(err)
	}
	if strings.TrimSpace(payload.Title) != strings.TrimSpace(args.ExpectedTitle) {
		return nil, PreconditionFailed("title_mismatch",
			"expectedTitle 与素材当前标题不一致，已拒绝删除；请先读取素材确认标题", nil)
	}
	if err := ctx.Domain.DeleteUserAsset(ctx.UserID, args.AssetID); err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{"assetId": args.AssetID, "deleted": true}, nil
}

// buildAssetDocument 构造满足素材库文档合同的最小完整 JSON：
// kind/title/coverUrl/tags/data 为必填字段，媒体类素材的定位符校验在这里
// 天然不适用（内容型素材没有媒体定位符）。
func buildAssetDocument(kind string, args assetCreateArgs) (json.RawMessage, error) {
	var data map[string]any
	switch kind {
	case "text":
		if strings.TrimSpace(args.Content) == "" {
			return nil, InvalidArg("invalid_params", "text 素材需要非空 content")
		}
		data = map[string]any{"content": args.Content}
	case "entity":
		if len(args.Definition) == 0 {
			return nil, InvalidArg("invalid_params", "entity 素材需要非空 definition 对象")
		}
		data = map[string]any{"definition": args.Definition}
	}
	tags := args.Tags
	if tags == nil {
		tags = []string{}
	}
	document := map[string]any{
		"kind": kind, "title": args.Title, "coverUrl": "", "tags": tags, "data": data,
	}
	if value := strings.TrimSpace(args.Category); value != "" {
		document["category"] = value
	}
	if value := strings.TrimSpace(args.FolderID); value != "" {
		document["folderId"] = value
	}
	if strings.TrimSpace(args.Note) != "" {
		document["note"] = args.Note
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, AsError(err)
	}
	return encoded, nil
}

func validateAssetTitle(title string) error {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return InvalidArg("invalid_params", "素材标题不能为空")
	}
	if len([]rune(trimmed)) > maxAssetTitleRunes {
		return InvalidArg("invalid_params", "素材标题过长")
	}
	return nil
}
