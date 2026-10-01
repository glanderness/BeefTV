package plugins

import (
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

// Service is the typed plugin-domain boundary. It owns management policy,
// user/platform activation, and delegates registry mutation to Runtime.
// Lifecycle locks live on the persistent Runtime: the host constructs a new
// Service per call, so a Service-local mutex cannot serialize install or
// availability updates.
type Service struct {
	runtime *Runtime
	store   Store
}

func New(runtime *Runtime, store Store) *Service {
	return &Service{runtime: runtime, store: store}
}

func (s *Service) Runtime() *Runtime {
	if s == nil {
		return nil
	}
	return s.runtime
}

func (s *Service) runtimeItems() []View {
	if s == nil || s.runtime == nil {
		return []View{}
	}
	return s.runtime.List()
}

func (s *Service) List() []View {
	items := s.runtimeItems()
	for index := range items {
		items[index].Management = ManagementFromView(items[index])
	}
	return items
}

func (s *Service) Registry() *protocol.Registry {
	if s == nil || s.runtime == nil {
		return nil
	}
	return s.runtime.Registry()
}

func (s *Service) Install(data []byte, fileName string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	plugin, err := s.runtime.Install(data, fileName)
	if err != nil {
		return View{}, err
	}
	plugin.Management = ManagementFromView(plugin)
	return plugin, nil
}

func (s *Service) InstallUploaded(actorID string, data []byte, fileName string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	parsed, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return View{}, err
	}
	if IsReservedApplication(parsed.Manifest.Metadata.ID) {
		return View{}, fmt.Errorf("插件 ID %q 由官方应用保留", parsed.Manifest.Metadata.ID)
	}
	if s.store == nil {
		return View{}, fmt.Errorf("插件状态存储未初始化")
	}
	s.runtime.beginMutation()
	defer s.runtime.endMutation()
	outcome, err := s.runtime.installLocked(data, fileName)
	if err != nil {
		return View{}, err
	}
	now := time.Now()
	state := &model.PluginPlatformState{PluginID: outcome.view.Manifest.ID, Available: outcome.view.Status == StatusEnabled, UpdatedBy: actorID, CreatedAt: now, UpdatedAt: now}
	if err := s.store.SavePluginPlatformState(state); err != nil {
		return View{}, joinMutationError(fmt.Errorf("保存插件平台状态：%w", err), s.runtime.rollbackInstall(outcome))
	}
	s.runtime.commitInstall(outcome)
	plugin := outcome.view
	plugin.Management = ManagementFromView(plugin)
	return plugin, nil
}

func (s *Service) SetEnabled(id string, enabled bool) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	plugin, err := s.runtime.SetEnabled(id, enabled)
	if err != nil {
		return View{}, err
	}
	plugin.Management = ManagementFromView(plugin)
	return plugin, nil
}

func (s *Service) Uninstall(id string) error {
	if s == nil || s.runtime == nil {
		return fmt.Errorf("插件运行时未初始化")
	}
	return s.runtime.Uninstall(id)
}

func (s *Service) UninstallUploaded(id string) error {
	if s == nil || s.runtime == nil {
		return fmt.Errorf("插件运行时未初始化")
	}
	s.runtime.beginMutation()
	defer s.runtime.endMutation()
	outcome, err := s.runtime.uninstallLocked(id)
	if err != nil {
		return err
	}
	if s.store != nil {
		if err := s.store.DeleteUserPluginStates(id); err != nil {
			return joinMutationError(fmt.Errorf("清理用户插件状态：%w", err), s.runtime.rollbackUninstall(outcome))
		}
		if err := s.store.DeletePluginPlatformState(id); err != nil {
			return joinMutationError(fmt.Errorf("清理插件平台状态：%w", err), s.runtime.rollbackUninstall(outcome))
		}
	}
	s.runtime.commitUninstall(outcome)
	return nil
}

func (s *Service) Package(id string) ([]byte, string, error) {
	if s == nil || s.runtime == nil {
		return nil, "", fmt.Errorf("插件运行时未初始化")
	}
	return s.runtime.Package(id)
}

func (s *Service) StatesForUser(actor *model.User) (map[string]StateView, error) {
	items := s.List()
	result := make(map[string]StateView, len(items)+len(officialApplicationPolicies))
	for _, pluginID := range KnownIDs(items) {
		state, err := s.stateForUser(actor, pluginID, items)
		if err != nil {
			return nil, err
		}
		result[pluginID] = state
	}
	return result, nil
}

func (s *Service) stateForUser(actor *model.User, pluginID string, items []View) (StateView, error) {
	runtimePlugin, hasRuntime := ByID(items, pluginID)
	source := "bundled"
	if hasRuntime {
		source = runtimePlugin.Source
	} else if !IsKnownApplication(pluginID) {
		return StateView{}, fmt.Errorf("插件 %q 不存在", pluginID)
	}
	policy := Management(pluginID, source)
	platformAvailable := policy.Kind == KindApplication
	if hasRuntime && (policy.ActivationScope == ScopeSystem || s.store == nil) {
		platformAvailable = runtimePlugin.Status == StatusEnabled
	}
	if s.store != nil {
		platformState, err := s.store.PluginPlatformState(pluginID)
		if err != nil {
			return StateView{}, fmt.Errorf("读取插件平台状态：%w", err)
		}
		if platformState != nil {
			platformAvailable = platformState.Available
		}
	}

	userEnabled := false
	userConfigured := false
	if policy.ActivationScope == ScopeUser && actor != nil {
		if s.store != nil {
			userState, err := s.store.UserPluginState(actor.ID, pluginID)
			if err != nil {
				return StateView{}, fmt.Errorf("读取用户插件状态：%w", err)
			}
			if userState != nil {
				userEnabled, userConfigured = userState.Enabled, true
			}
		}
		// Preserve the old globally-enabled workflow behavior until each user
		// explicitly saves a personal choice. Other official applications were
		// already controlled by each user's local installation state.
		if !userConfigured {
			if pluginID == MediaConversion {
				userEnabled = true
			} else if hasRuntime && pluginID == WorkflowRunningHub {
				userEnabled = runtimePlugin.Status == StatusEnabled
			}
		}
	}
	effective := platformAvailable
	if policy.ActivationScope == ScopeUser {
		effective = platformAvailable && userEnabled
	}
	state := StateView{
		PluginID: pluginID, PlatformAvailable: platformAvailable,
		UserEnabled: userEnabled, UserConfigured: userConfigured,
		EffectiveEnabled: effective,
		CanToggle:        policy.ActivationScope == ScopeUser && platformAvailable,
		CanConfigure:     policy.ConfigurationScope == ConfigurationUser && platformAvailable,
	}
	if !platformAvailable {
		state.BlockedReason = "管理员已停用该插件"
	} else if policy.ActivationScope == ScopeSystem {
		state.BlockedReason = "系统插件由管理员统一管理"
	}
	return state, nil
}

func (s *Service) SetUserEnabled(actor *model.User, pluginID string, enabled bool) (StateView, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return StateView{}, Forbidden("请先登录")
	}
	items := s.List()
	current, err := s.stateForUser(actor, pluginID, items)
	if err != nil {
		return StateView{}, err
	}
	runtimePlugin, hasRuntime := ByID(items, pluginID)
	source := "bundled"
	if hasRuntime {
		source = runtimePlugin.Source
	}
	if Management(pluginID, source).ActivationScope != ScopeUser {
		return StateView{}, Forbidden("系统插件只能由管理员统一管理")
	}
	if !current.PlatformAvailable {
		return StateView{}, Forbidden("管理员已停用该插件")
	}
	if s.store == nil {
		return StateView{}, fmt.Errorf("插件状态存储未初始化")
	}
	now := time.Now()
	state := &model.UserPluginState{ID: kernel.NewID(), UserID: actor.ID, PluginID: pluginID, Enabled: enabled, CreatedAt: now, UpdatedAt: now}
	if err := s.store.SaveUserPluginState(state); err != nil {
		return StateView{}, fmt.Errorf("保存用户插件状态：%w", err)
	}
	return s.stateForUser(actor, pluginID, items)
}

func (s *Service) AdminStates(actor *model.User) (map[string]AdminStateView, error) {
	states, err := s.StatesForUser(actor)
	if err != nil {
		return nil, err
	}
	if s.store == nil {
		return nil, fmt.Errorf("插件状态存储未初始化")
	}
	counts, err := s.store.EnabledPluginUserCounts()
	if err != nil {
		return nil, fmt.Errorf("统计插件启用用户数：%w", err)
	}
	result := make(map[string]AdminStateView, len(states))
	for pluginID, state := range states {
		result[pluginID] = AdminStateView{StateView: state, EnabledUserCount: counts[pluginID]}
	}
	return result, nil
}

func (s *Service) SetPlatformAvailability(actor *model.User, pluginID string, available bool) (AdminStateView, ManagementView, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return AdminStateView{}, ManagementView{}, Forbidden("请先登录")
	}
	if s == nil {
		return AdminStateView{}, ManagementView{}, fmt.Errorf("插件运行时未初始化")
	}
	if s.store == nil {
		return AdminStateView{}, ManagementView{}, fmt.Errorf("插件状态存储未初始化")
	}
	if s.runtime != nil {
		s.runtime.beginMutation()
		defer s.runtime.endMutation()
	}
	items := s.List()
	runtimePlugin, hasRuntime := ByID(items, pluginID)
	source := "bundled"
	if hasRuntime {
		source = runtimePlugin.Source
	} else if !IsKnownApplication(pluginID) {
		return AdminStateView{}, ManagementView{}, fmt.Errorf("插件 %q 不存在", pluginID)
	}
	policy := Management(pluginID, source)
	runtimeMutated := false
	var previous []RegistryRecord
	if policy.ActivationScope == ScopeSystem {
		if !hasRuntime || s.runtime == nil {
			return AdminStateView{}, policy, fmt.Errorf("插件 %q 缺少运行时", pluginID)
		}
		stored, err := s.runtime.readRegistry()
		if err != nil {
			return AdminStateView{}, policy, err
		}
		previous = cloneRegistryRecords(stored)
		if _, err := s.runtime.setEnabledLocked(pluginID, available); err != nil {
			return AdminStateView{}, policy, err
		}
		runtimeMutated = true
	}
	now := time.Now()
	platformState := &model.PluginPlatformState{PluginID: pluginID, Available: available, UpdatedBy: actor.ID, CreatedAt: now, UpdatedAt: now}
	if err := s.store.SavePluginPlatformState(platformState); err != nil {
		saveErr := fmt.Errorf("保存插件平台状态：%w", err)
		if runtimeMutated {
			return AdminStateView{}, policy, joinMutationError(saveErr, s.runtime.restoreRegistry(previous))
		}
		return AdminStateView{}, policy, saveErr
	}
	states, err := s.AdminStates(actor)
	if err != nil {
		return AdminStateView{}, policy, err
	}
	return states[pluginID], policy, nil
}

func (s *Service) RequireForUser(userID string, pluginID string) error {
	state, err := s.stateForUser(&model.User{ID: strings.TrimSpace(userID)}, pluginID, s.List())
	if err != nil {
		return err
	}
	if !state.EffectiveEnabled {
		if state.BlockedReason != "" {
			return Forbidden(state.BlockedReason)
		}
		return Forbidden("插件未启用")
	}
	return nil
}

func (s *Service) WorkflowStatuses() map[string]string {
	statuses := make(map[string]string, 1)
	for _, pluginID := range []string{WorkflowRunningHub} {
		state, err := s.stateForUser(nil, pluginID, s.List())
		if err == nil && state.PlatformAvailable {
			statuses[pluginID] = StatusEnabled
		} else {
			statuses[pluginID] = StatusDisabled
		}
	}
	return statuses
}

func (s *Service) WorkflowStatusesForUser(userID string) (map[string]string, error) {
	statuses := make(map[string]string, 1)
	actor := &model.User{ID: strings.TrimSpace(userID)}
	items := s.List()
	for _, pluginID := range []string{WorkflowRunningHub} {
		state, err := s.stateForUser(actor, pluginID, items)
		if err != nil {
			return nil, err
		}
		if state.EffectiveEnabled {
			statuses[pluginID] = StatusEnabled
		} else {
			statuses[pluginID] = StatusDisabled
		}
	}
	return statuses, nil
}

func (s *Service) RequireWorkflowForInterface(interfaceType string) error {
	pluginID, ok := WorkflowIDForInterface(interfaceType)
	if !ok {
		return Forbidden("未知工作流插件")
	}
	status, exists := s.WorkflowStatuses()[pluginID]
	if !exists || status != StatusEnabled {
		if pluginID == WorkflowRunningHub {
			return Forbidden("RunningHub 工作流插件未启用")
		}
		return Forbidden("工作流插件未启用")
	}
	return nil
}

func (s *Service) RequireWorkflowForUser(userID string, interfaceType string) error {
	pluginID, ok := WorkflowIDForInterface(interfaceType)
	if !ok {
		return Forbidden("未知工作流插件")
	}
	if err := s.RequireForUser(userID, pluginID); err != nil {
		if pluginID == WorkflowRunningHub {
			return Forbidden("RunningHub 工作流插件未启用")
		}
		return Forbidden("工作流插件未启用")
	}
	return nil
}
