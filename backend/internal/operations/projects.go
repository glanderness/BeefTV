package operations

import (
	"encoding/json"
	"strings"
)

// maxProjectNameRunes 对齐 model.Project 的 Name 长度约束（size:240）。
const maxProjectNameRunes = 240

func opProjectList(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		Page     int `json:"page"`
		PageSize int `json:"pageSize"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	page, size := normalizeProjectPage(args.Page, args.PageSize)
	result, err := ctx.Domain.ListProjectsPage(ctx.UserID, page, size)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(result), nil
}

func opProjectGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		ProjectID string `json:"projectId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.ProjectID) == "" {
		return nil, InvalidArg("invalid_params", "projectId 必填")
	}
	detail, err := ctx.Domain.ProjectDetail(ctx.UserID, args.ProjectID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(detail), nil
}

func opProjectCreate(ctx *Context, params json.RawMessage) (any, error) {
	var args ProjectCreateInput
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if err := validateProjectName(args.Name); err != nil {
		return nil, err
	}
	project, err := ctx.Domain.CreateProject(ctx.UserID, args)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(map[string]any{"created": project}), nil
}

func opProjectUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		ProjectID         string  `json:"projectId"`
		ExpectedRevision  int64   `json:"expectedRevision"`
		Name              *string `json:"name"`
		Type              *string `json:"type"`
		AspectRatio       *string `json:"aspectRatio"`
		SourceType        *string `json:"sourceType"`
		Description       *string `json:"description"`
		Status            *string `json:"status"`
		DefaultImageModel *string `json:"defaultImageModel"`
		DefaultVideoModel *string `json:"defaultVideoModel"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.ProjectID) == "" {
		return nil, InvalidArg("invalid_params", "projectId 必填")
	}
	if args.Name != nil {
		if err := validateProjectName(*args.Name); err != nil {
			return nil, err
		}
	}
	if args.ExpectedRevision <= 0 {
		return nil, InvalidArg("invalid_params", "expectedRevision 必填")
	}
	// 先按调用方观察到的 revision 预检：让 stale 写在进领域前就得到明确的冲突回执。
	// 领域内部仍带 CAS，两层都失败时以领域结果为准。
	current, err := ctx.Domain.OwnedProject(ctx.UserID, args.ProjectID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if current.Revision != args.ExpectedRevision {
		return nil, Conflict("stale_revision", "项目已被其他操作更新，请重新读取后再保存", nil)
	}
	input := ProjectUpdateInput{
		Name: derefString(args.Name), Type: derefString(args.Type),
		AspectRatio: derefString(args.AspectRatio), SourceType: derefString(args.SourceType),
		Status: derefString(args.Status), Description: args.Description,
		DefaultImageModel: args.DefaultImageModel, DefaultVideoModel: args.DefaultVideoModel,
	}
	updated, err := ctx.Domain.UpdateProject(ctx.UserID, args.ProjectID, input)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(map[string]any{"updated": updated}), nil
}

// opProjectDelete 删除项目是不可逆的高危写：必须带上项目当前名称做二次确认，
// 名称不匹配即拒绝，防止调用方拿错 ID 误删整部短剧的生产数据。
func opProjectDelete(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		ProjectID    string `json:"projectId"`
		ExpectedName string `json:"expectedName"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.ProjectID) == "" {
		return nil, InvalidArg("invalid_params", "projectId 必填")
	}
	if strings.TrimSpace(args.ExpectedName) == "" {
		return nil, InvalidArg("invalid_params", "expectedName 必填（须与项目当前名称一致才执行删除）")
	}
	current, err := ctx.Domain.OwnedProject(ctx.UserID, args.ProjectID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if strings.TrimSpace(current.Name) != strings.TrimSpace(args.ExpectedName) {
		return nil, PreconditionFailed("name_mismatch",
			"expectedName 与项目当前名称不一致，已拒绝删除；请先读取项目确认名称", nil)
	}
	if err := ctx.Domain.DeleteProject(ctx.UserID, args.ProjectID); err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{"projectId": args.ProjectID, "deleted": true}, nil
}

func validateProjectName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return InvalidArg("invalid_params", "项目名称不能为空")
	}
	if len([]rune(trimmed)) > maxProjectNameRunes {
		return InvalidArg("invalid_params", "项目名称过长")
	}
	return nil
}

func normalizeProjectPage(page int, pageSize int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
