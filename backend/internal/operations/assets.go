package operations

import (
	"encoding/json"
	"image"
	// 注册标准库图片格式解码器，用于上传前读取图片宽高并校验文件确实是图片。
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

// maxAssetTitleRunes 对齐 model.Asset 的 Title 长度约束（size:240）。
const maxAssetTitleRunes = 240

// assetContentKinds 是无需媒体资源即可创建的内容型素材。
// 媒体类素材（image/video/audio/model）必须携带 resourceId：元数据全部
// 取自资源记录，外部不能伪造 width/bytes/mimeType 等定位信息。
var assetContentKinds = map[string]struct{}{
	"text":   {},
	"entity": {},
}

// assetMediaKinds 是可以从已就绪资源登记为素材的媒体类型（对齐 Resource.Kind）。
var assetMediaKinds = map[string]struct{}{
	"image": {},
	"video": {},
	"audio": {},
	"model": {},
}

// assetCreateArgs 是创建素材的入参：内容型走 kind+content/definition，
// 媒体型走 resourceId（kind 可省略，由资源类型推导）。
type assetCreateArgs struct {
	Kind       string         `json:"kind"`
	ResourceID string         `json:"resourceId"`
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
	if err := validateAssetTitle(args.Title); err != nil {
		return nil, err
	}
	resourceID := strings.TrimSpace(args.ResourceID)
	if resourceID != "" {
		document, err := buildMediaAssetDocument(ctx, args, resourceID)
		if err != nil {
			return nil, err
		}
		return persistAssetDocument(ctx, document)
	}
	kind := strings.TrimSpace(args.Kind)
	if _, ok := assetContentKinds[kind]; !ok {
		return nil, InvalidArg("unsupported_kind",
			"内容型素材只支持 text/entity；创建图片、视频、音频或模型素材请提供 resourceId（上传或生成产物的资源 ID），由服务端从资源记录构造")
	}
	document, err := buildAssetDocument(kind, args)
	if err != nil {
		return nil, err
	}
	return persistAssetDocument(ctx, document)
}

// persistAssetDocument 走全量 upsert 落库并返回统一回执。
func persistAssetDocument(ctx *Context, document json.RawMessage) (any, error) {
	summary, err := ctx.Domain.UpsertUserAsset(ctx.UserID, document)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"assetId": summary.ID, "kind": summary.Kind, "category": summary.Category,
		"title": summary.Title, "createdAt": summary.CreatedAt, "updatedAt": summary.UpdatedAt,
	}, nil
}

// buildMediaAssetDocument 从已就绪且归属当前用户的资源构造媒体素材文档：
// 元数据（尺寸、大小、MIME、时长）全部取自资源记录，对齐工作流产物落素材
// 的文档形状（storageKey=resource:<id>，coverUrl/URL 指向资源服务）。
func buildMediaAssetDocument(ctx *Context, args assetCreateArgs, resourceID string) (json.RawMessage, error) {
	if strings.TrimSpace(args.Content) != "" || len(args.Definition) > 0 {
		return nil, InvalidArg("invalid_params", "resourceId 与 content/definition 互斥，媒体素材元数据由资源记录决定")
	}
	resource, err := ctx.Domain.OwnedReadyResource(ctx.UserID, resourceID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if declared := strings.TrimSpace(args.Kind); declared != "" && declared != strings.ToLower(strings.TrimSpace(resource.Kind)) {
		return nil, InvalidArg("kind_mismatch", "kind 与资源实际类型不一致（资源是 "+resource.Kind+"）")
	}
	return mediaAssetDocumentFromResource(*resource, assetMetaFields{
		Title: args.Title, Tags: args.Tags, Category: args.Category, FolderID: args.FolderID, Note: args.Note,
	})
}

// assetMetaFields 是登记素材时调用方可给的元字段（title 必填，其余可选）。
type assetMetaFields struct {
	Title    string
	Tags     []string
	Category string
	FolderID string
	Note     string
}

// mediaAssetDocumentFromResource 用资源记录构造媒体素材文档；kind 以资源类型为准。
func mediaAssetDocumentFromResource(resource model.Resource, meta assetMetaFields) (json.RawMessage, error) {
	kind := strings.ToLower(strings.TrimSpace(resource.Kind))
	if _, ok := assetMediaKinds[kind]; !ok {
		return nil, InvalidArg("unsupported_kind", "资源类型不支持登记为素材: "+resource.Kind)
	}
	resourceURL := "/api/resources/" + resource.ID + "/file"
	data := map[string]any{
		"storageKey": "resource:" + resource.ID,
		"mimeType":   resource.MimeType,
		"bytes":      resource.Size,
	}
	if kind == "image" {
		width, height := positiveDimension(resource.Width), positiveDimension(resource.Height)
		data["width"], data["height"] = width, height
		data["dataUrl"] = resourceURL
	} else {
		data["width"], data["height"] = resource.Width, resource.Height
		data["url"] = resourceURL
		if resource.DurationMs > 0 {
			data["durationMs"] = resource.DurationMs
		}
	}
	if kind == "model" {
		fileName := strings.TrimSpace(resource.ObjectKey)
		if fileName == "" {
			return nil, PreconditionFailed("model_file_name_missing", "模型资源缺少文件名，无法登记为素材", nil)
		}
		data["fileName"] = fileName
	}
	tags := meta.Tags
	if tags == nil {
		tags = []string{}
	}
	document := map[string]any{
		"kind": kind, "title": meta.Title, "coverUrl": resourceURL, "tags": tags, "data": data,
	}
	if value := strings.TrimSpace(meta.Category); value != "" {
		document["category"] = value
	}
	if value := strings.TrimSpace(meta.FolderID); value != "" {
		document["folderId"] = value
	}
	if strings.TrimSpace(meta.Note) != "" {
		document["note"] = meta.Note
	}
	encoded, marshalErr := json.Marshal(document)
	if marshalErr != nil {
		return nil, AsError(marshalErr)
	}
	return encoded, nil
}

func positiveDimension(value int) int {
	if value <= 0 {
		return 1
	}
	return value
}

// opAssetUpload 把本机文件上传进资源库并自动登记为素材：
// MCP/CLI 与 BeefTV 后端同机，调用方只传文件路径，文件内容不经过模型上下文。
// 上传身份沿用操作幂等键——同一 operationId 重试时资源域直接返回已就绪资源。
func opAssetUpload(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		FilePath string   `json:"filePath"`
		Title    string   `json:"title"`
		Tags     []string `json:"tags"`
		Category string   `json:"category"`
		FolderID string   `json:"folderId"`
		Note     string   `json:"note"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if err := validateAssetTitle(args.Title); err != nil {
		return nil, err
	}
	file, width, height, size, closeErr := openLocalImage(args.FilePath)
	if closeErr != nil {
		return nil, closeErr
	}
	defer file.Close()
	resource, err := ctx.Domain.UploadLocalFile(ctx.UserID, filepath.Base(args.FilePath), size,
		"image", width, height, 0, file, string(ctx.Caller.Kind)+":"+ctx.OpID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	document, err := mediaAssetDocumentFromResource(*resource, assetMetaFields{
		Title: args.Title, Tags: args.Tags, Category: args.Category, FolderID: args.FolderID, Note: args.Note,
	})
	if err != nil {
		return nil, err
	}
	summary, err := ctx.Domain.UpsertUserAsset(ctx.UserID, document)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"assetId": summary.ID, "resourceId": resource.ID, "kind": summary.Kind,
		"category": summary.Category, "title": summary.Title,
		"createdAt": summary.CreatedAt, "updatedAt": summary.UpdatedAt,
	}, nil
}

// openLocalImage 打开本机图片文件并读取宽高：必须是可以解码的图片，其余格式拒绝。
// 路径必须是绝对路径——相对路径的基准进程不明，宁可拒绝也不猜。
func openLocalImage(rawPath string) (*os.File, int, int, int64, error) {
	path := strings.TrimSpace(rawPath)
	if path == "" {
		return nil, 0, 0, 0, InvalidArg("invalid_params", "filePath 必填")
	}
	if !filepath.IsAbs(path) {
		return nil, 0, 0, 0, InvalidArg("invalid_params", "filePath 必须是绝对路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, 0, 0, NotFound("file_not_found", "文件不存在或不可访问: "+path)
	}
	if !info.Mode().IsRegular() {
		return nil, 0, 0, 0, InvalidArg("invalid_params", "filePath 必须指向普通文件")
	}
	if info.Size() <= 0 {
		return nil, 0, 0, 0, InvalidArg("invalid_params", "文件为空")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, 0, 0, NotFound("file_not_found", "文件无法打开: "+path)
	}
	config, _, decodeErr := image.DecodeConfig(file)
	if decodeErr != nil {
		file.Close()
		return nil, 0, 0, 0, InvalidArg("unsupported_kind",
			"asset.upload 当前只支持 png/jpeg/gif 图片；其他媒体请先经上传或生成链路进入资源库，再用 asset.create 的 resourceId 登记")
	}
	if _, err := file.Seek(0, 0); err != nil {
		file.Close()
		return nil, 0, 0, 0, AsError(err)
	}
	return file, config.Width, config.Height, info.Size(), nil
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
