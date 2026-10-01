package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

var logicalModelCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,79}$`)

type LogicalModelRequest struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	Capability  string `json:"capability"`
	Enabled     bool   `json:"enabled"`
	SortOrder   int    `json:"sortOrder"`
	// LegacyModelIDs 只用于将用户本地保存的旧目录选择迁移到当前模型家族，
	// 不能用它重写任务或路由尝试中的不可变快照。
	LegacyModelIDs []string              `json:"legacyModelIds"`
	CapabilitySpec CapabilitySpec        `json:"capabilitySpec"`
	DefaultOptions map[string]any        `json:"defaultOptions"`
	Routes         []LogicalRouteRequest `json:"routes"`
	// SourceChannelModelID 仅供系统渠道同步流程使用。
	SourceChannelModelID string `json:"-"`
}
type LogicalRouteRequest struct {
	ChannelModelID string `json:"channelModelId"`
	Enabled        bool   `json:"enabled"`
	Priority       int    `json:"priority"`
	Weight         int    `json:"weight"`
}

type PublicLogicalModel struct {
	ID             string         `json:"id"`
	Code           string         `json:"code"`
	Name           string         `json:"name"`
	Icon           string         `json:"icon"`
	Description    string         `json:"description"`
	Capability     string         `json:"capability"`
	SortOrder      int            `json:"sortOrder"`
	LegacyModelIDs []string       `json:"legacyModelIds"`
	CapabilitySpec CapabilitySpec `json:"capabilitySpec"`
	// CapabilityProfiles 是创作端可见的匿名能力组合，不暴露其背后的供应线路关系。
	CapabilityProfiles []CapabilitySpec `json:"capabilityProfiles"`
	DefaultOptions     map[string]any   `json:"defaultOptions"`
	Available          bool             `json:"available"`
}

type AdminLogicalRoute struct {
	ID                    string `json:"id"`
	ChannelModelID        string `json:"channelModelId"`
	ChannelID             string `json:"channelId"`
	ChannelModelKey       string `json:"channelModelKey"`
	ChannelModelName      string `json:"channelModelName"`
	Enabled               bool   `json:"enabled"`
	Priority              int    `json:"priority"`
	Weight                int    `json:"weight"`
	Available             bool   `json:"available"`
	structurallyAvailable bool
	CapabilitySpec        CapabilitySpec `json:"capabilitySpec"`
}

type AdminLogicalModel struct {
	PublicLogicalModel
	Enabled            bool                `json:"enabled"`
	ActiveRevisionID   string              `json:"activeRevisionId"`
	RevisionVersion    int                 `json:"revisionVersion"`
	ConfigurationError string              `json:"configurationError,omitempty"`
	AvailabilityError  string              `json:"availabilityError,omitempty"`
	Routes             []AdminLogicalRoute `json:"routes"`
}

type RouteSimulationCandidate struct {
	RouteID          string   `json:"routeId"`
	ChannelModelID   string   `json:"channelModelId"`
	ChannelModelKey  string   `json:"channelModelKey"`
	ChannelModelName string   `json:"channelModelName"`
	Priority         int      `json:"priority"`
	Weight           int      `json:"weight"`
	Enabled          bool     `json:"enabled"`
	Matched          bool     `json:"matched"`
	Blocked          bool     `json:"blocked"`
	InPool           bool     `json:"inPool"`
	Reasons          []string `json:"reasons,omitempty"`
}

type RouteSimulationResult struct {
	ProductMatch CapabilityMatch            `json:"productMatch"`
	Candidates   []RouteSimulationCandidate `json:"candidates"`
}

func (s *Service) PublicLogicalModels(intent *ModelRequestIntent) ([]PublicLogicalModel, error) {
	snapshot, err := s.routeCatalogSnapshot()
	if err != nil {
		return nil, err
	}
	result := make([]PublicLogicalModel, 0, len(snapshot.Ordered))
	for _, id := range snapshot.Ordered {
		cached := snapshot.Models[id]
		structuralSpecs := availableCachedRouteSpecs(cached.Routes)
		coverageValid := logicalModelCapabilityCovered(cached.ProductSpec, structuralSpecs)
		available := coverageValid && hasHealthyCachedRoute(s, cached.Routes)
		if intent != nil {
			resolvedIntent := *intent
			resolvedIntent.Options = mergeIntentDefaults(intent.Options, cached.Defaults)
			productMatch := MatchCapability(cached.ProductSpec, resolvedIntent)
			if !productMatch.Matched {
				continue
			}
			available = false
			if coverageValid {
				for _, route := range cached.Routes {
					if route.Route.Enabled && route.Route.Weight > 0 && !s.logicalRouteBlocked(route) && MatchCapability(route.CapabilitySpec, resolvedIntent).Matched {
						available = true
						break
					}
				}
			}
		}
		result = append(result, publicLogicalModel(cached, available))
	}
	return result, nil
}

func publicLogicalModel(cached cachedLogicalModel, available bool) PublicLogicalModel {
	item := cached.Model
	productSpec := capabilitySpecWithRoutePresets(cached.ProductSpec, enabledLogicalRouteSpecs(cached.Routes))
	profiles := make([]CapabilitySpec, 0, len(cached.Routes))
	seen := make(map[string]bool, len(cached.Routes))
	for _, route := range cached.Routes {
		if !route.Route.Enabled || route.Route.Weight <= 0 {
			continue
		}
		key := capabilityFingerprint(route.CapabilitySpec)
		if !seen[key] {
			seen[key] = true
			profiles = append(profiles, route.CapabilitySpec)
		}
	}

	return PublicLogicalModel{
		ID: item.ID, Code: item.Code, Name: item.Name, Icon: item.Icon,
		Description: item.Description, Capability: item.Capability, SortOrder: item.SortOrder,
		LegacyModelIDs: decodeLegacyModelIDs(item.LegacyModelIDsJSON),
		CapabilitySpec: productSpec, CapabilityProfiles: profiles,
		DefaultOptions: cached.Defaults, Available: available,
	}
}

func enabledLogicalRouteSpecs(routes []cachedLogicalRoute) []CapabilitySpec {
	specs := make([]CapabilitySpec, 0, len(routes))
	for _, route := range routes {
		if !route.Route.Enabled || route.Route.Weight <= 0 {
			continue
		}
		specs = append(specs, route.CapabilitySpec)
	}
	return specs
}

// capabilitySpecWithRoutePresets repairs old front-model snapshots that stored
// only `*` for a custom size. The wildcard remains for matching custom values,
// while route presets are restored for admin and creator-side selectors.
// Callers must pass only currently enabled routes; disabled or zero-weight
// routes would otherwise advertise size tiers the public catalog cannot route.

// capabilityFingerprint 用规范化后的结构去重能力画像；不能直接依赖原始 JSON，
// 因为同一组枚举能力的数组顺序不应造成重复展示。

func (s *Service) AdminLogicalModels(actor *model.User) ([]AdminLogicalModel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	items, err := s.repo.LogicalModels(true)
	if err != nil {
		return nil, err
	}
	graphs, err := s.repo.LogicalModelGraphs(items, true)
	if err != nil {
		return nil, err
	}
	systemChannelIDs := make([]string, 0)
	for _, graph := range graphs {
		if graph == nil {
			continue
		}
		for _, channelModel := range graph.ChannelModels {
			systemChannelIDs = append(systemChannelIDs, channelModel.ChannelID)
		}
	}
	systemChannels, err := s.repo.SystemChannelsByIDs(systemChannelIDs, true)
	if err != nil {
		return nil, err
	}
	systemChannelByID := make(map[string]model.ModelChannel, len(systemChannels))
	for _, channel := range systemChannels {
		systemChannelByID[channel.ID] = channel
	}
	result := make([]AdminLogicalModel, 0, len(items))
	for _, item := range items {
		graph := graphs[item.ID]
		if graph == nil || graph.Revision == nil {
			continue
		}
		admin, buildErr := s.buildAdminLogicalModel(item, graph, systemChannelByID)
		if buildErr != nil {
			return nil, buildErr
		}
		result = append(result, *admin)
	}
	return result, nil
}

func (s *Service) buildAdminLogicalModel(item model.LogicalModel, graph *repository.LogicalModelGraph, systemChannelByID map[string]model.ModelChannel) (*AdminLogicalModel, error) {
	productSpec, err := DecodeCapabilitySpec(graph.Revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	channelModelByID := make(map[string]model.ChannelModel, len(graph.ChannelModels))
	for _, channelModel := range graph.ChannelModels {
		channelModelByID[channelModel.ID] = channelModel
	}
	admin := AdminLogicalModel{PublicLogicalModel: publicLogicalModel(cachedLogicalModel{Model: item, ProductSpec: productSpec, Defaults: map[string]any{}}, false), Enabled: item.Enabled, ActiveRevisionID: graph.Revision.ID, RevisionVersion: graph.Revision.Version, Routes: []AdminLogicalRoute{}}
	for _, route := range graph.Routes {
		channelModel, channelOK := channelModelByID[route.ChannelModelID]
		if !channelOK {
			return nil, errors.New("供应线路引用的渠道模型不存在")
		}
		capabilitySpec, specErr := channelModelCapabilitySpec(channelModel)
		if specErr != nil {
			return nil, specErr
		}
		_, channelOK = systemChannelByID[channelModel.ChannelID]
		structurallyAvailable := route.Enabled && route.Weight > 0 && channelModel.Enabled && channelOK
		available := structurallyAvailable
		admin.Routes = append(admin.Routes, AdminLogicalRoute{ID: route.ID, ChannelModelID: channelModel.ID, ChannelID: channelModel.ChannelID, ChannelModelKey: channelModel.ModelKey, ChannelModelName: channelModel.DisplayName, Enabled: route.Enabled, Priority: route.Priority, Weight: route.Weight, Available: available, structurallyAvailable: structurallyAvailable, CapabilitySpec: capabilitySpec})
	}
	routeSpecs := make([]CapabilitySpec, 0, len(admin.Routes))
	for _, route := range admin.Routes {
		routeSpecs = append(routeSpecs, route.CapabilitySpec)
	}
	productSpec = capabilitySpecWithRoutePresets(productSpec, routeSpecs)
	defaults, err := decodeLogicalDefaults(graph.Revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	admin.PublicLogicalModel = publicLogicalModel(cachedLogicalModel{Model: item, ProductSpec: productSpec, Defaults: defaults}, false)
	// publicLogicalModel above has no route list; admin routes are already attached
	// and the enriched product spec is the source used by the editor.
	admin.CapabilitySpec = productSpec
	admin.DefaultOptions = defaults
	structuralRouteSpecs := structuralAdminRouteSpecs(admin.Routes)
	admin.ConfigurationError = logicalModelConfigurationError(productSpec, structuralRouteSpecs)
	admin.AvailabilityError = ""
	admin.Available = len(structuralRouteSpecs) > 0 && admin.ConfigurationError == ""
	return &admin, nil
}

func countAvailableAdminRoutes(routes []AdminLogicalRoute) int {
	count := 0
	for _, route := range routes {
		if route.Available {
			count++
		}
	}
	return count
}

func structuralAdminRouteSpecs(routes []AdminLogicalRoute) []CapabilitySpec {
	result := make([]CapabilitySpec, 0, len(routes))
	for _, route := range routes {
		if route.structurallyAvailable {
			result = append(result, route.CapabilitySpec)
		}
	}
	return result
}

func availableCachedRouteSpecs(routes []cachedLogicalRoute) []CapabilitySpec {
	result := make([]CapabilitySpec, 0, len(routes))
	for _, route := range routes {
		if route.Route.Enabled && route.Route.Weight > 0 {
			result = append(result, route.CapabilitySpec)
		}
	}
	return result
}

func hasHealthyCachedRoute(s *Service, routes []cachedLogicalRoute) bool {
	for _, route := range routes {
		if route.Route.Enabled && route.Route.Weight > 0 && !s.logicalRouteBlocked(route) {
			return true
		}
	}
	return false
}

func logicalModelCapabilityCovered(product CapabilitySpec, routeSpecs []CapabilitySpec) bool {
	return len(routeSpecs) > 0 && validateProductSpecWithinRoutes(product, routeSpecs) == nil
}

func logicalModelConfigurationError(product CapabilitySpec, routeSpecs []CapabilitySpec) string {
	if len(routeSpecs) == 0 || logicalModelCapabilityCovered(product, routeSpecs) {
		return ""
	}
	return "供应线路已无法完整覆盖创作端能力，请调整线路或能力范围"
}

func (s *Service) SaveAdminLogicalModel(actor *model.User, id string, req LogicalModelRequest) (*AdminLogicalModel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	item, revision, routes, creating, err := s.logicalModelBundle(actor, id, req)
	if err != nil {
		return nil, err
	}
	if err := s.repo.SaveLogicalModelBundle(item, revision, routes, creating); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	// 模型、版本和路由属于后台关键配置，保存成功却缺失审计记录不能静默返回成功。
	if err := s.appendAdminAudit(actor, map[bool]string{true: "logical_model.create", false: "logical_model.update"}[creating], "logical_model", item.ID, "保存前台模型及供应线路", map[string]any{"revisionId": revision.ID, "routeCount": len(routes)}); err != nil {
		return nil, err
	}
	graph, err := s.repo.LogicalModelGraph(item.ID, true)
	if err != nil {
		return nil, err
	}
	channelIDs := make([]string, 0, len(graph.ChannelModels))
	for _, channelModel := range graph.ChannelModels {
		channelIDs = append(channelIDs, channelModel.ChannelID)
	}
	systemChannels, err := s.repo.SystemChannelsByIDs(channelIDs, true)
	if err != nil {
		return nil, err
	}
	systemChannelByID := make(map[string]model.ModelChannel, len(systemChannels))
	for _, channel := range systemChannels {
		systemChannelByID[channel.ID] = channel
	}
	return s.buildAdminLogicalModel(*item, graph, systemChannelByID)
}

func (s *Service) DeleteAdminLogicalModel(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	item, err := s.repo.LogicalModel(strings.TrimSpace(id))
	if logicalModelNotFound(err) {
		return BadAuthRequest("前台模型不存在或已删除")
	}
	if err != nil {
		return err
	}
	if item.ArchivedAt != nil {
		return BadAuthRequest("前台模型不存在或已删除")
	}
	if item.SourceChannelModelID != "" {
		return BadAuthRequest("该前台模型由系统渠道自动同步，请在系统渠道模型中停用")
	}
	audit, err := newAdminAuditEvent(actor, "logical_model.archive", "logical_model", item.ID, "归档前台模型", map[string]any{"code": item.Code, "name": item.Name})
	if err != nil {
		return err
	}
	if err := s.repo.ArchiveLogicalModel(item.ID, audit, time.Now()); err != nil {
		if errors.Is(err, repository.ErrLogicalModelInUse) {
			return BadAuthRequest("前台模型仍被排队中或进行中任务使用，请等待任务结束后再归档")
		}
		if logicalModelNotFound(err) {
			return BadAuthRequest("前台模型不存在或已删除")
		}
		return err
	}
	s.invalidateRouteCatalog()
	return nil
}

func (s *Service) logicalModelBundle(actor *model.User, id string, req LogicalModelRequest) (*model.LogicalModel, *model.LogicalModelRevision, []model.LogicalModelRoute, bool, error) {
	code := strings.ToLower(strings.TrimSpace(req.Code))
	name := strings.TrimSpace(req.Name)
	capability := normalizeCapability(req.Capability)
	if !logicalModelCodePattern.MatchString(code) {
		return nil, nil, nil, false, BadAuthRequest("模型 code 需为 2-80 位小写字母、数字、点、下划线或连字符")
	}
	if name == "" || len([]rune(name)) > 120 {
		return nil, nil, nil, false, BadAuthRequest("请填写 1-120 个字符的模型名称")
	}
	sourceChannelModelID := strings.TrimSpace(req.SourceChannelModelID)
	if sourceChannelModelID != "" {
		source, sourceErr := s.repo.ChannelModel(sourceChannelModelID)
		if sourceErr != nil {
			return nil, nil, nil, false, BadAuthRequest("系统渠道模型不存在")
		}
		if _, channelErr := s.repo.AdminSystemChannel(source.ChannelID); channelErr != nil {
			return nil, nil, nil, false, BadAuthRequest("前台模型只能同步系统渠道模型")
		}
		capability = normalizeCapability(source.Capability)
		derivedSpec, specErr := channelModelCapabilitySpec(*source)
		if specErr != nil {
			return nil, nil, nil, false, specErr
		}
		derivedDefaults, defaultsErr := channelModelDefaultOptions(*source, derivedSpec)
		if defaultsErr != nil {
			return nil, nil, nil, false, defaultsErr
		}
		if len(req.Routes) == 0 {
			req.CapabilitySpec = derivedSpec
			req.DefaultOptions = derivedDefaults
			req.Routes = []LogicalRouteRequest{{ChannelModelID: source.ID, Enabled: true, Priority: 100, Weight: 100}}
		}
		if strings.TrimSpace(id) == "" {
			req.Enabled = source.Enabled
		}
	}
	normalizedSpec, err := NormalizeCapabilitySpec(req.CapabilitySpec)
	if err != nil {
		return nil, nil, nil, false, err
	}
	req.CapabilitySpec = normalizedSpec
	if normalizeCapability(req.CapabilitySpec.Capability) != capability {
		return nil, nil, nil, false, BadAuthRequest("前台模型类型与能力配置不一致")
	}
	normalizedDefaults, err := normalizeLogicalDefaults(req.CapabilitySpec, req.DefaultOptions)
	if err != nil {
		return nil, nil, nil, false, err
	}
	req.DefaultOptions = normalizedDefaults
	creating := strings.TrimSpace(id) == ""
	var item *model.LogicalModel
	if creating {
		id, err = s.repo.NextPrefixedID("LMODEL")
		if err != nil {
			return nil, nil, nil, false, err
		}
		item = &model.LogicalModel{ID: id, CreatedAt: time.Now()}
	} else {
		item, err = s.repo.LogicalModel(id)
		if err != nil {
			return nil, nil, nil, false, err
		}
		if item.ArchivedAt != nil {
			return nil, nil, nil, false, BadAuthRequest("前台模型不存在或已删除")
		}
	}
	item.Code, item.Name, item.Icon, item.Description, item.Capability = code, name, strings.TrimSpace(req.Icon), strings.TrimSpace(req.Description), capability
	if sourceChannelModelID != "" {
		item.SourceChannelModelID = sourceChannelModelID
	}
	item.Enabled, item.SortOrder = req.Enabled, req.SortOrder
	if req.LegacyModelIDs != nil {
		legacyJSON, marshalErr := json.Marshal(normalizeLegacyModelIDs(req.LegacyModelIDs))
		if marshalErr != nil {
			return nil, nil, nil, false, marshalErr
		}
		item.LegacyModelIDsJSON = string(legacyJSON)
	}
	item.UpdatedAt = time.Now()
	revisionID, err := s.repo.NextPrefixedID("REVISION")
	if err != nil {
		return nil, nil, nil, false, err
	}
	specJSON, err := json.Marshal(req.CapabilitySpec)
	if err != nil {
		return nil, nil, nil, false, fmt.Errorf("序列化前台模型能力合同失败：%w", err)
	}
	defaultsJSON, err := json.Marshal(defaultMap(req.DefaultOptions))
	if err != nil {
		return nil, nil, nil, false, fmt.Errorf("序列化前台模型默认参数失败：%w", err)
	}
	revision := &model.LogicalModelRevision{ID: revisionID, LogicalModelID: item.ID, CapabilitySpecJSON: string(specJSON), DefaultOptionsJSON: string(defaultsJSON), CreatedBy: actor.ID, CreatedAt: time.Now()}
	routes := make([]model.LogicalModelRoute, 0, len(req.Routes))
	seenChannelModels := make(map[string]bool, len(req.Routes))
	structuralRouteSpecs := make([]CapabilitySpec, 0, len(req.Routes))
	for _, input := range req.Routes {
		channelModelID := strings.TrimSpace(input.ChannelModelID)
		if channelModelID == "" || seenChannelModels[channelModelID] {
			return nil, nil, nil, false, BadAuthRequest("供应线路必须选择不重复的渠道模型")
		}
		seenChannelModels[channelModelID] = true
		channelModel, modelErr := s.repo.ChannelModel(channelModelID)
		if modelErr != nil {
			return nil, nil, nil, false, BadAuthRequest("供应线路引用的渠道模型不存在")
		}
		capabilitySpec, specErr := channelModelCapabilitySpec(*channelModel)
		if specErr != nil {
			return nil, nil, nil, false, specErr
		}
		if normalizeCapability(capabilitySpec.Capability) != capability {
			return nil, nil, nil, false, BadAuthRequest("供应线路能力类型与前台模型不一致")
		}
		if req.Enabled && input.Enabled && input.Weight <= 0 {
			return nil, nil, nil, false, BadAuthRequest("启用供应线路的同级权重必须大于 0")
		}
		if input.Weight < 0 {
			return nil, nil, nil, false, BadAuthRequest("供应线路的同级权重不能为负数")
		}
		if _, channelErr := s.repo.SystemChannel(channelModel.ChannelID); channelErr != nil {
			return nil, nil, nil, false, BadAuthRequest("供应线路只能选择系统渠道模型")
		}
		if req.Enabled && input.Enabled && channelModel.Enabled {
			structuralRouteSpecs = append(structuralRouteSpecs, capabilitySpec)
		}
		routeID, idErr := s.repo.NextPrefixedID("ROUTE")
		if idErr != nil {
			return nil, nil, nil, false, idErr
		}
		routes = append(routes, model.LogicalModelRoute{ID: routeID, ChannelModelID: channelModel.ID, Enabled: input.Enabled, Priority: input.Priority, Weight: input.Weight, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	}
	// 停用必须始终可执行；重新启用时再强校验结构能力。
	if req.Enabled {
		if len(structuralRouteSpecs) == 0 {
			return nil, nil, nil, false, BadAuthRequest("启用前台模型前至少需要一条已启用的供应线路")
		}
		if err := validateProductSpecWithinRoutes(req.CapabilitySpec, structuralRouteSpecs); err != nil {
			return nil, nil, nil, false, err
		}
	}
	return item, revision, routes, creating, nil
}

func defaultMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func (s *Service) SimulateLogicalModelRoute(actor *model.User, id string, intent ModelRequestIntent) (*RouteSimulationResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	snapshot, err := s.routeCatalogSnapshot()
	if err != nil {
		return nil, err
	}
	cached, ok := snapshot.Models[id]
	if !ok {
		return nil, BadAuthRequest("前台模型未启用或尚未发布")
	}
	intent.Options = mergeIntentDefaults(intent.Options, cached.Defaults)
	return &RouteSimulationResult{ProductMatch: MatchCapability(cached.ProductSpec, intent), Candidates: s.sortedRouteDiagnostics(cached.Routes, intent)}, nil
}

func logicalModelNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }

// 前台模型只声明供应线路真实提供的总目录；组合是否可承接仍由匿名 capabilityProfiles 按 OR 语义判断。
