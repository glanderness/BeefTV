package app

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"log"
	"math"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

// ModelRequestIntentFromTaskInput 从统一任务输入推导路由意图；它只统计实际输入和显式参数，不假设任何固定图片数或视频时长。

type cachedLogicalModel struct {
	Model       model.LogicalModel
	Revision    model.LogicalModelRevision
	ProductSpec CapabilitySpec
	Defaults    map[string]any
	Routes      []cachedLogicalRoute
}

type cachedLogicalRoute struct {
	Route          model.LogicalModelRoute
	CapabilitySpec CapabilitySpec
	ChannelModel   model.ChannelModel
}

type routeCatalogSnapshot struct {
	LoadedAt       time.Time
	CatalogVersion int64
	Models         map[string]cachedLogicalModel
	Ordered        []string
}

type RoutedModel struct {
	LogicalModel model.LogicalModel
	Revision     model.LogicalModelRevision
	Route        model.LogicalModelRoute
	ChannelModel model.ChannelModel
	Variant      *model.ChannelModelVariant
	Defaults     map[string]any
}

func decodeLogicalDefaults(raw string, spec CapabilitySpec) (map[string]any, error) {
	defaults := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &defaults); err != nil {
		return nil, err
	}
	return normalizeLogicalDefaults(spec, defaults)
}

func (s *Service) invalidateRouteCatalog() {
	s.routeCatalogRefreshMu.Lock()
	s.routeCatalogMu.Lock()
	s.routeCatalog = nil
	s.routeCatalogVersion++
	s.routeCatalogRetryAt = time.Time{}
	s.routeCatalogRefreshError = nil
	s.routeCatalogMu.Unlock()
	s.routeCatalogRefreshMu.Unlock()
	if s.coordinator != nil {
		ctx, cancel := context.WithTimeout(context.Background(), runtimeCoordinationTimeout)
		defer cancel()
		if err := s.coordinator.BumpRouteCatalogVersion(ctx); err != nil {
			log.Printf("logical model route catalog distributed invalidation failed: %v", err)
		}
	}
	s.initReadCaches()
	s.routeVersionReadCache.Clear()
}

func (s *Service) routeCatalogSnapshot() (*routeCatalogSnapshot, error) {
	now := time.Now()
	version := s.currentRouteCatalogVersion()
	s.routeCatalogMu.RLock()
	snapshot := s.routeCatalog
	if snapshot != nil && now.Sub(snapshot.LoadedAt) < s.routeCatalogTTL && snapshot.CatalogVersion == version {
		s.routeCatalogMu.RUnlock()
		return snapshot, nil
	}
	s.routeCatalogMu.RUnlock()

	s.routeCatalogRefreshMu.Lock()
	defer s.routeCatalogRefreshMu.Unlock()
	now = time.Now()
	version = s.currentRouteCatalogVersion()
	s.routeCatalogMu.RLock()
	snapshot = s.routeCatalog
	if snapshot != nil && now.Sub(snapshot.LoadedAt) < s.routeCatalogTTL && snapshot.CatalogVersion == version {
		s.routeCatalogMu.RUnlock()
		return snapshot, nil
	}
	s.routeCatalogMu.RUnlock()

	// 刷新锁只能防止并行回源，失败后还需要冷却，否则等待者会逐个重打数据库。
	if s.routeCatalogRefreshError != nil && now.Before(s.routeCatalogRetryAt) {
		if snapshot != nil && snapshot.CatalogVersion == version && now.Sub(snapshot.LoadedAt) <= s.routeCatalogMaxStale {
			return snapshot, nil
		}
		return nil, s.routeCatalogRefreshError
	}
	loaded, err := s.loadRouteCatalog()
	if err != nil {
		s.routeCatalogRefreshError = err
		s.routeCatalogRetryAt = time.Now().Add(2 * time.Second)
		log.Printf("logical model route catalog refresh failed; retry cooled down: %v", err)
		// 已有快照过期时允许短暂继续服务，数据库首次加载失败则明确失败。
		if snapshot != nil && snapshot.CatalogVersion == version && now.Sub(snapshot.LoadedAt) <= s.routeCatalogMaxStale {
			return snapshot, nil
		}
		return nil, err
	}
	s.routeCatalogRefreshError = nil
	s.routeCatalogRetryAt = time.Time{}
	s.routeCatalogMu.Lock()
	s.routeCatalog = loaded
	s.routeCatalogMu.Unlock()
	return loaded, nil
}

func (s *Service) currentRouteCatalogVersion() int64 {
	s.routeCatalogMu.RLock()
	defer s.routeCatalogMu.RUnlock()
	return s.routeCatalogVersion
}

func (s *Service) loadRouteCatalog() (*routeCatalogSnapshot, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	repo := s.repo.WithContext(ctx)
	items, err := repo.LogicalModels(false)
	if err != nil {
		return nil, err
	}
	snapshot := &routeCatalogSnapshot{LoadedAt: time.Now(), CatalogVersion: s.currentRouteCatalogVersion(), Models: make(map[string]cachedLogicalModel), Ordered: make([]string, 0, len(items))}
	graphs, err := repo.LogicalModelGraphs(items, false)
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
	systemChannels, err := repo.SystemChannelsByIDs(systemChannelIDs, false)
	if err != nil {
		return nil, err
	}
	enabledSystemChannels := make(map[string]bool, len(systemChannels))
	for _, channel := range systemChannels {
		enabledSystemChannels[channel.ID] = true
	}
	for _, item := range items {
		graph := graphs[item.ID]
		if graph == nil || graph.Revision == nil {
			log.Printf("logical model omitted from route catalog id=%s: graph unavailable", item.ID)
			continue
		}
		productSpec, decodeErr := DecodeCapabilitySpec(graph.Revision.CapabilitySpecJSON)
		if decodeErr != nil {
			log.Printf("logical model omitted from route catalog id=%s: invalid product capability: %v", item.ID, decodeErr)
			continue
		}
		channelModelByID := make(map[string]model.ChannelModel, len(graph.ChannelModels))
		for _, channelModel := range graph.ChannelModels {
			channelModelByID[channelModel.ID] = channelModel
		}
		cached := cachedLogicalModel{Model: item, Revision: *graph.Revision, ProductSpec: productSpec, Defaults: map[string]any{}}
		for _, route := range graph.Routes {
			channelModel, ok := channelModelByID[route.ChannelModelID]
			if !ok || !channelModel.Enabled || !enabledSystemChannels[channelModel.ChannelID] {
				continue
			}
			capabilitySpec, specErr := channelModelCapabilitySpec(channelModel)
			if specErr != nil {
				log.Printf("logical route omitted from catalog route_id=%s channel_model_id=%s: invalid capability: %v", route.ID, channelModel.ID, specErr)
				continue
			}
			cached.Routes = append(cached.Routes, cachedLogicalRoute{Route: route, CapabilitySpec: capabilitySpec, ChannelModel: channelModel})
		}
		productSpec = capabilitySpecWithRoutePresets(productSpec, enabledLogicalRouteSpecs(cached.Routes))
		defaults, defaultsErr := decodeLogicalDefaults(graph.Revision.DefaultOptionsJSON, productSpec)
		if defaultsErr != nil {
			log.Printf("logical model omitted from route catalog id=%s: invalid defaults: %v", item.ID, defaultsErr)
			continue
		}
		cached.ProductSpec = productSpec
		cached.Defaults = defaults
		snapshot.Models[item.ID] = cached
		snapshot.Ordered = append(snapshot.Ordered, item.ID)
	}
	return snapshot, nil
}

// ResolveLogicalModel 将创作意图解析为一次可执行的路由快照。
// 解析同时约束能力合同、启用状态、上游变体和渠道协议；调用方不得在解析完成后自行替换其中任一供应链字段，
// 否则会出现“目录显示可用、任务实际走另一条线路”的配置漂移。
func (s *Service) ResolveLogicalModel(logicalModelID string, intent ModelRequestIntent) (*RoutedModel, error) {
	snapshot, err := s.routeCatalogSnapshot()
	if err != nil {
		return nil, err
	}
	cached, ok := snapshot.Models[strings.TrimSpace(logicalModelID)]
	if !ok {
		return nil, BadAuthRequest("所选模型不可用")
	}
	intent.Options = mergeIntentDefaults(intent.Options, cached.Defaults)
	if match := MatchCapability(cached.ProductSpec, intent); !match.Matched {
		return nil, BadAuthRequest("所选模型不支持当前请求：" + strings.Join(match.Reasons, "；"))
	}
	eligible := s.eligibleLogicalRoutes(cached.Routes, intent, nil)
	if len(eligible) == 0 {
		return nil, BadAuthRequest("当前模型暂时无法满足这组输入和参数")
	}
	selected := weightedRoute(eligible)
	variant := channelModelVariantForIntent(selected.ChannelModel, intent)
	return &RoutedModel{LogicalModel: cached.Model, Revision: cached.Revision, Route: selected.Route, ChannelModel: selected.ChannelModel, Variant: variant, Defaults: cached.Defaults}, nil
}

func (s *Service) eligibleLogicalRoutes(routes []cachedLogicalRoute, intent ModelRequestIntent, tried map[string]bool) []cachedLogicalRoute {
	eligible := make([]cachedLogicalRoute, 0, len(routes))
	maxPriority := math.MinInt
	for _, route := range routes {
		if !route.Route.Enabled || route.Route.Weight <= 0 || tried[route.Route.ID] || s.logicalRouteBlocked(route) {
			continue
		}
		if match := MatchCapability(route.CapabilitySpec, intent); !match.Matched {
			continue
		}
		if len(route.ChannelModel.Variants) > 0 && channelModelVariantForIntent(route.ChannelModel, intent) == nil {
			continue
		}
		if route.Route.Priority > maxPriority {
			eligible = eligible[:0]
			maxPriority = route.Route.Priority
		}
		if route.Route.Priority == maxPriority {
			eligible = append(eligible, route)
		}
	}
	return eligible
}

// channelModelVariantForIntent 使用“精确规格优先、通配规格兜底”的规则。SKU 选择器与
// 运行意图使用同一组规范键。

func (s *Service) logicalRouteBlocked(route cachedLogicalRoute) bool {
	now := time.Now()
	keys := []string{"channel:" + route.ChannelModel.ChannelID, "channel-model:" + route.ChannelModel.ID, "route:" + route.Route.ID}
	// 这里会删除过期项，必须使用写锁；不要改成 RLock。
	s.routeHealthMu.Lock()
	for _, key := range keys {
		until, exists := s.routeHealthBlocked[key]
		if !exists {
			continue
		}
		if !until.After(now) {
			delete(s.routeHealthBlocked, key)
			continue
		}
		s.routeHealthMu.Unlock()
		return true
	}
	s.routeHealthMu.Unlock()

	return false
}

func weightedRoute(routes []cachedLogicalRoute) cachedLogicalRoute {
	if len(routes) == 1 {
		return routes[0]
	}
	var total int64
	for _, route := range routes {
		total += int64(route.Route.Weight)
	}
	if total <= 0 {
		return routes[0]
	}
	var raw [8]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return routes[0]
	}
	totalUnsigned := uint64(total)
	// 丢弃不能整除 total 的低概率尾部，避免取模造成轻微权重偏差。
	threshold := -totalUnsigned % totalUnsigned
	randomValue := binary.LittleEndian.Uint64(raw[:])
	for randomValue < threshold {
		if _, err := cryptorand.Read(raw[:]); err != nil {
			return routes[0]
		}
		randomValue = binary.LittleEndian.Uint64(raw[:])
	}
	pick := int64(randomValue % totalUnsigned)
	for _, route := range routes {
		if pick < int64(route.Route.Weight) {
			return route
		}
		pick -= int64(route.Route.Weight)
	}
	return routes[len(routes)-1]
}

func (s *Service) sortedRouteDiagnostics(routes []cachedLogicalRoute, intent ModelRequestIntent) []RouteSimulationCandidate {
	result := make([]RouteSimulationCandidate, 0, len(routes))
	poolPriority := math.MinInt
	for _, route := range routes {
		match := MatchCapability(route.CapabilitySpec, intent)
		blocked := s.logicalRouteBlocked(route)
		if route.Route.Enabled && route.Route.Weight > 0 && match.Matched && !blocked && route.Route.Priority > poolPriority {
			poolPriority = route.Route.Priority
		}
		result = append(result, RouteSimulationCandidate{RouteID: route.Route.ID, ChannelModelID: route.ChannelModel.ID, ChannelModelKey: route.ChannelModel.ModelKey, ChannelModelName: route.ChannelModel.DisplayName, Priority: route.Route.Priority, Weight: route.Route.Weight, Enabled: route.Route.Enabled, Matched: match.Matched, Blocked: blocked, Reasons: match.Reasons})
	}
	for index := range result {
		result[index].InPool = result[index].Enabled && result[index].Weight > 0 && result[index].Matched && !result[index].Blocked && result[index].Priority == poolPriority
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Priority > result[j].Priority })
	return result
}

func (s *Service) createRouteAttempt(task *model.Task, routed *RoutedModel, attemptNumber int) (*model.RouteAttempt, error) {
	id, err := s.repo.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	channelModel, err := s.repo.ChannelModelByID(routed.ChannelModel.ChannelID, routed.ChannelModel.ID)
	if err != nil {
		return nil, err
	}
	attempt := &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: attemptNumber, LogicalModelID: routed.LogicalModel.ID, LogicalModelRevisionID: routed.Revision.ID, RouteID: routed.Route.ID, ChannelModelID: channelModel.ID, ChannelID: channelModel.ChannelID, Status: "selected", DispatchState: "not_sent", StartedAt: time.Now()}
	if err := s.repo.CreateRouteAttempt(attempt); err != nil {
		return nil, err
	}
	return attempt, nil
}

func (s *Service) beginTaskRouteAttempt(task *model.Task) (*model.RouteAttempt, error) {
	if task == nil {
		return nil, nil
	}
	attempts, err := s.repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil {
		return nil, err
	}
	if len(attempts) > 0 {
		existing := &attempts[len(attempts)-1]
		if task.Type == "canvas_image" && (existing.DispatchState == "submission_unknown" || existing.DispatchState == "accepted") {
			if _, err := s.repo.ImageSubmission(existing.ID, task.ID, task.UserID); err == nil {
				return existing, nil
			}
		}
		switch existing.DispatchState {
		case "not_sent":
			return existing, nil
		case "accepted":
			if existing.ProviderRequestID != "" || task.ProviderRequestID != "" {
				if task.ProviderRequestID == "" {
					task.ProviderRequestID = existing.ProviderRequestID
					if err := s.repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
						return nil, err
					}
				}
				return existing, nil
			}
			return nil, routeDispatchUncertainError{"上游已接受请求，但没有可恢复的任务 ID"}
		case "submission_unknown":
			if existing.ProviderRequestID != "" || task.ProviderRequestID != "" {
				if task.ProviderRequestID == "" {
					task.ProviderRequestID = existing.ProviderRequestID
					if err := s.repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
						return nil, err
					}
				}
				existing.DispatchState = "accepted"
				if err := s.repo.SaveRouteAttempt(existing); err != nil {
					return nil, err
				}
				return existing, nil
			}
			return nil, routeDispatchUncertainError{"上一次提交结果不明确，为避免重复创建上游任务已停止自动重发"}
		case "rejected_no_job":
			if task.Type == "canvas_image" && existing.FailureCode == "image_throttled" && existing.AttemptNumber < 3 {
				if next, err := s.retryRejectedImageAttempt(task, existing, providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`}); next != nil || err != nil {
					return next, err
				}
			}
			if task.Type == "canvas_image" {
				return nil, errors.New("上游已拒绝本次图片请求，请查看失败原因")
			}
			if task.LogicalModelID == "" {
				return nil, errors.New("上游已拒绝本次请求，请检查渠道配置后再试")
			}
			return s.switchTaskToNextRoute(task, attempts)
		}
	}
	if task.LogicalModelID == "" {
		return s.createDirectTaskAttempt(task)
	}
	routed, routeErr := s.routedModelForTaskSelection(task)
	if routeErr != nil {
		return s.switchTaskToNextRoute(task, attempts)
	}
	return s.createRouteAttempt(task, routed, len(attempts)+1)
}

func (s *Service) markRouteAttemptDispatching(attempt *model.RouteAttempt) error {
	if attempt == nil || attempt.DispatchState != "not_sent" {
		return nil
	}
	// A stale worker must not dispatch the same selected attempt a second time.
	if err := s.repo.MarkRouteAttemptDispatching(attempt.ID); err != nil {
		return routeDispatchUncertainError{"提交状态未能独占确认，为避免重复创建上游任务已停止自动重发"}
	}
	attempt.Status, attempt.DispatchState = "dispatching", "submission_unknown"
	return nil
}

type routeDispatchUncertainError struct{ message string }

func (e routeDispatchUncertainError) Error() string { return e.message }

func isRouteDispatchUncertain(err error) bool {
	var target routeDispatchUncertainError
	return errors.As(err, &target)
}

func (s *Service) routedModelForTaskSelection(task *model.Task) (*RoutedModel, error) {
	route, err := s.repo.LogicalModelRoute(task.RouteID)
	if err != nil {
		return nil, err
	}
	if !route.Enabled || route.Weight <= 0 || route.LogicalModelRevisionID != task.LogicalModelRevisionID {
		return nil, errors.New("任务使用的模型服务配置已失效")
	}
	if route.ChannelModelID != task.ChannelModelID {
		return nil, errors.New("任务使用的模型服务配置已失效")
	}
	channelModel, err := s.repo.ChannelModel(task.ChannelModelID)
	if err != nil {
		return nil, err
	}
	if !channelModel.Enabled {
		return nil, errors.New("任务使用的模型服务配置已失效")
	}
	if _, err := s.repo.SystemChannel(channelModel.ChannelID); err != nil {
		return nil, err
	}
	logicalModel, err := s.repo.LogicalModel(task.LogicalModelID)
	if err != nil {
		return nil, err
	}
	revision, err := s.repo.LogicalModelRevision(task.LogicalModelRevisionID)
	if err != nil {
		return nil, err
	}
	if revision.LogicalModelID != logicalModel.ID {
		return nil, errors.New("任务前台模型版本不一致")
	}
	productSpec, err := DecodeCapabilitySpec(revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	defaults, err := decodeLogicalDefaults(revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	capabilitySpec, err := channelModelCapabilitySpec(*channelModel)
	if err != nil || s.logicalRouteBlocked(cachedLogicalRoute{Route: *route, CapabilitySpec: capabilitySpec, ChannelModel: *channelModel}) {
		return nil, errors.New("当前模型服务暂不可用")
	}
	routed := &RoutedModel{LogicalModel: *logicalModel, Revision: *revision, Route: *route, ChannelModel: *channelModel, Defaults: defaults}
	return routed, nil
}

func (s *Service) switchTaskToNextRoute(task *model.Task, attempts []model.RouteAttempt) (*model.RouteAttempt, error) {
	decrypted, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(decrypted), &input); err != nil {
		return nil, BadAuthRequest("任务输入格式无效，无法恢复模型服务")
	}
	logicalModel, err := s.repo.LogicalModel(task.LogicalModelID)
	if err != nil {
		return nil, err
	}
	revision, err := s.repo.LogicalModelRevision(task.LogicalModelRevisionID)
	if err != nil || revision.LogicalModelID != logicalModel.ID {
		return nil, errors.New("任务前台模型版本不存在或归属不一致")
	}
	productSpec, err := DecodeCapabilitySpec(revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	defaults, err := decodeLogicalDefaults(revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	intent := ModelRequestIntentFromTaskInput(input, task.Type, task.Operation)
	intent.Options = mergeIntentDefaults(intent.Options, defaults)
	if match := MatchCapability(productSpec, intent); !match.Matched {
		return nil, BadAuthRequest("任务参数不再符合前台模型能力：" + strings.Join(match.Reasons, "；"))
	}
	routes, err := s.repo.LogicalModelRoutes(revision.ID, false)
	if err != nil {
		return nil, err
	}
	channelModelIDs := make([]string, 0, len(routes))
	for _, route := range routes {
		channelModelIDs = append(channelModelIDs, route.ChannelModelID)
	}
	channelModels, err := s.repo.ChannelModelsByIDs(channelModelIDs)
	if err != nil {
		return nil, err
	}
	channelIDs := make([]string, 0, len(channelModels))
	for _, channelModel := range channelModels {
		channelIDs = append(channelIDs, channelModel.ChannelID)
	}
	systemChannels, err := s.repo.SystemChannelsByIDs(channelIDs, false)
	if err != nil {
		return nil, err
	}
	enabledSystemChannels := make(map[string]bool, len(systemChannels))
	for _, channel := range systemChannels {
		enabledSystemChannels[channel.ID] = true
	}
	channelModelByID := make(map[string]model.ChannelModel, len(channelModels))
	for _, channelModel := range channelModels {
		if channelModel.Enabled && enabledSystemChannels[channelModel.ChannelID] {
			channelModelByID[channelModel.ID] = channelModel
		}
	}
	candidates := make([]cachedLogicalRoute, 0, len(routes))
	for _, route := range routes {
		channelModel, channelOK := channelModelByID[route.ChannelModelID]
		if !channelOK {
			continue
		}
		capabilitySpec, specErr := channelModelCapabilitySpec(channelModel)
		if specErr != nil {
			continue
		}
		candidates = append(candidates, cachedLogicalRoute{Route: route, CapabilitySpec: capabilitySpec, ChannelModel: channelModel})
	}
	tried := make(map[string]bool, len(attempts))
	for _, attempt := range attempts {
		tried[attempt.RouteID] = true
	}
	eligible := s.eligibleLogicalRoutes(candidates, intent, tried)
	if len(eligible) == 0 {
		return nil, BadAuthRequest("当前模型暂时无法满足这组输入和参数")
	}
	selected := weightedRoute(eligible)
	variant := channelModelVariantForIntent(selected.ChannelModel, intent)
	routed := &RoutedModel{LogicalModel: *logicalModel, Revision: *revision, Route: selected.Route, ChannelModel: selected.ChannelModel, Variant: variant, Defaults: defaults}
	nextInput := applyRoutedProviderSelection(input, routed)
	if err := s.ValidateTaskCapability(nextInput); err != nil {
		return nil, err
	}
	if err := s.protectTaskSecrets(nextInput); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(nextInput)
	if err != nil {
		return nil, err
	}
	previousRouteID := task.RouteID
	if err := s.repo.SwitchTaskLogicalRoute(task.ID, previousRouteID, selected.Route.ID, string(encoded), selected.ChannelModel.ID); err != nil {
		return nil, err
	}
	task.RouteID = selected.Route.ID
	task.ChannelModelID = selected.ChannelModel.ID
	task.InputJSON = string(encoded)
	task.ProviderRequestID = ""
	return s.createRouteAttempt(task, routed, len(attempts)+1)
}

func (s *Service) nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	if task != nil && task.Type == "canvas_image" && attempt != nil {
		if attempt.AttemptNumber >= 3 || !definiteImageThrottle(taskErr) {
			return nil, nil
		}
		if _, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err != nil {
			return nil, nil
		}
		return s.retryRejectedImageAttempt(task, attempt, taskErr)
	}
	if task == nil || task.LogicalModelID == "" || attempt == nil || attempt.DispatchState != "rejected_no_job" {
		return nil, nil
	}
	if errors.Is(taskErr, context.Canceled) || errors.Is(taskErr, context.DeadlineExceeded) {
		return nil, nil
	}
	s.blockLogicalRouteForFailure(attempt, taskErr)
	attempts, err := s.repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil {
		return nil, err
	}
	return s.switchTaskToNextRoute(task, attempts)
}

func (s *Service) blockLogicalRouteForFailure(attempt *model.RouteAttempt, taskErr error) {
	if attempt == nil {
		return
	}
	key := ""
	duration := time.Duration(0)
	if attempt.FailureCode == "upstream_401" || attempt.FailureCode == "upstream_403" {
		key, duration = "channel:"+attempt.ChannelID, 10*time.Minute
	} else if attempt.FailureCode == "upstream_404" {
		key, duration = "channel-model:"+attempt.ChannelModelID, 10*time.Minute
	} else if attempt.FailureCode == "upstream_429" {
		key, duration = "channel:"+attempt.ChannelID, 30*time.Second
		var upstream providerHTTPError
		if errors.As(taskErr, &upstream) && upstream.RetryAfter > 0 {
			duration = upstream.RetryAfter
		}
	}
	if key == "" || duration <= 0 {
		return
	}
	until := time.Now().Add(duration)
	s.routeHealthMu.Lock()
	// 本地状态是 Redis 不可用时的降级，也能覆盖 Redis 写入瞬间的网络抖动。
	s.routeHealthBlocked[key] = until
	s.routeHealthMu.Unlock()
}

func (s *Service) prepareLogicalTaskRetry(task *model.Task, input map[string]any) error {
	if task == nil || task.LogicalModelID == "" {
		return nil
	}
	intent := ModelRequestIntentFromTaskInput(input, task.Type, task.Operation)
	logicalModel, err := s.repo.LogicalModel(task.LogicalModelID)
	if err != nil {
		return err
	}
	var routed *RoutedModel
	if logicalModel.ArchivedAt != nil {
		// 归档只隐藏新任务的公开目录；历史任务重试必须使用任务快照，不能重新从公开目录选路。
		routed, err = s.resolveArchivedTaskRoute(task, intent)
	} else {
		routed, err = s.ResolveLogicalModel(task.LogicalModelID, intent)
	}
	if err != nil {
		return err
	}
	input = applyRoutedProviderSelection(input, routed)
	if err := s.ValidateTaskCapability(input); err != nil {
		return err
	}
	if err := s.protectTaskSecrets(input); err != nil {
		return err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	task.LogicalModelRevisionID = routed.Revision.ID
	task.RouteID = routed.Route.ID
	task.ChannelModelID = routed.ChannelModel.ID
	task.Model = routed.LogicalModel.Code
	task.Provider = "managed"
	task.InputJSON = string(encoded)
	return nil
}

// resolveArchivedTaskRoute 恢复归档模型任务保存的 revision、route 和 channel model 快照。
// 归档模型不得重新进入公开路由目录；原供应线路失效时应明确拒绝重试，避免静默切换到未知配置。
func (s *Service) resolveArchivedTaskRoute(task *model.Task, intent ModelRequestIntent) (*RoutedModel, error) {
	if task == nil || task.LogicalModelID == "" || task.LogicalModelRevisionID == "" || task.RouteID == "" || task.ChannelModelID == "" {
		return nil, BadAuthRequest("历史任务缺少完整的模型服务快照，无法重试")
	}
	logicalModel, err := s.repo.LogicalModel(task.LogicalModelID)
	if err != nil {
		return nil, err
	}
	if logicalModel.ArchivedAt == nil {
		return nil, BadAuthRequest("任务模型已恢复为可用模型，请重新选择后重试")
	}
	revision, err := s.repo.LogicalModelRevision(task.LogicalModelRevisionID)
	if err != nil || revision.LogicalModelID != logicalModel.ID {
		return nil, BadAuthRequest("历史任务前台模型版本不存在或归属不一致")
	}
	route, err := s.repo.LogicalModelRoute(task.RouteID)
	if err != nil || route.LogicalModelRevisionID != revision.ID || route.ChannelModelID != task.ChannelModelID || !route.Enabled || route.Weight <= 0 {
		return nil, BadAuthRequest("历史任务原模型供应线路已失效，无法重试")
	}
	channelModel, err := s.repo.ChannelModel(task.ChannelModelID)
	if err != nil || !channelModel.Enabled {
		return nil, BadAuthRequest("历史任务原模型服务已失效，无法重试")
	}
	if _, err := s.repo.SystemChannel(channelModel.ChannelID); err != nil {
		return nil, BadAuthRequest("历史任务原模型渠道已失效，无法重试")
	}
	productSpec, err := DecodeCapabilitySpec(revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	defaults, err := decodeLogicalDefaults(revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	intent.Options = mergeIntentDefaults(intent.Options, defaults)
	if match := MatchCapability(productSpec, intent); !match.Matched {
		return nil, BadAuthRequest("历史任务不再符合前台模型能力：" + strings.Join(match.Reasons, "；"))
	}
	capabilitySpec, err := channelModelCapabilitySpec(*channelModel)
	if err != nil || s.logicalRouteBlocked(cachedLogicalRoute{Route: *route, CapabilitySpec: capabilitySpec, ChannelModel: *channelModel}) {
		return nil, BadAuthRequest("历史任务原模型供应线路暂不可用，无法重试")
	}
	return &RoutedModel{LogicalModel: *logicalModel, Revision: *revision, Route: *route, ChannelModel: *channelModel, Defaults: defaults}, nil
}

func (s *Service) finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error) {
	if attempt == nil {
		return
	}
	now := time.Now()
	attempt.CompletedAt = &now
	if task != nil {
		attempt.ProviderRequestID = task.ProviderRequestID
	}
	if taskErr == nil {
		attempt.Status = "succeeded"
		attempt.DispatchState = "accepted"
	} else {
		attempt.Status = "failed"
		attempt.FailureMessage = truncateRunes(taskFailureMessage(taskErr), 1000)
		attempt.FailureCode = routeFailureCode(taskErr)
		if task != nil && task.Type == "canvas_image" && definiteImageThrottle(taskErr) {
			attempt.FailureCode = "image_throttled"
		}
		if attempt.ProviderRequestID != "" {
			attempt.DispatchState = "accepted"
		} else if safeRouteRejection(taskErr) {
			attempt.DispatchState = "rejected_no_job"
		} else {
			attempt.DispatchState = "submission_unknown"
		}
		if task != nil && task.Type == "canvas_image" {
			row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
			if err == nil && row.ResponseAccepted {
				attempt.DispatchState = "accepted"
			} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				attempt.DispatchState = "submission_unknown"
			}
		}
	}
	if err := s.repo.SaveRouteAttempt(attempt); err != nil {
		log.Printf("route attempt terminal state save failed attempt_id=%s task_id=%s: %v", attempt.ID, attempt.TaskID, err)
	}
}

func routeFailureCode(err error) string {
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		return code
	}
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		return fmt.Sprintf("upstream_%d", upstream.StatusCode)
	}
	return "submission_unknown"
}

func safeRouteRejection(err error) bool {
	if err == nil {
		return false
	}
	var imageRecovery imageRecoveryError
	if errors.As(err, &imageRecovery) {
		return false
	}
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		return true
	}
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		switch upstream.StatusCode {
		case 401, 402, 403, 404, 429:
			return true
		}
	}
	return false
}
