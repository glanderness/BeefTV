package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

const (
	WorkflowPluginRunningHub = "runninghub-workflow-provider"
	WorkflowPluginComfyUI    = "comfyui-workflow-provider"
)

// bundledWorkflowPluginIDs 是所有「执行落在宿主 Go 代码、生命周期交给插件运行时」的
// 工作流能力。顺序同时决定插件列表与状态返回顺序。
func bundledWorkflowPluginIDs() []string {
	return []string{WorkflowPluginRunningHub, WorkflowPluginComfyUI}
}

// bundledWorkflowPluginManifests keeps workflow capabilities in the same
// runtime registry as protocol plugins. The execution implementation remains
// in the workflow provider adapter for now, but lifecycle and availability are
// governed by the plugin runtime rather than by individual UI consumers.
func bundledWorkflowPluginManifests() []protocol.Manifest {
	return []protocol.Manifest{
		workflowPluginManifest(WorkflowPluginRunningHub, "RunningHub 工作流", "在画布中拉取并执行 RunningHub Workflow 与 App。",
			[]protocol.Capability{protocol.CapabilityImage, protocol.CapabilityVideo, protocol.CapabilityAudio}),
		workflowPluginManifest(WorkflowPluginComfyUI, "ComfyUI 工作流", "连接本地或可信网络内的原生 ComfyUI，按工作流字段生成图片和视频。",
			[]protocol.Capability{protocol.CapabilityImage, protocol.CapabilityVideo}),
	}
}

func workflowPluginManifest(id, name, description string, capabilities []protocol.Capability) protocol.Manifest {
	workflows := make([]protocol.ManifestWorkflow, 0, len(capabilities))
	for _, capability := range capabilities {
		workflows = append(workflows, protocol.ManifestWorkflow{
			ID:         id + "-" + string(capability),
			Label:      name + " · " + string(capability),
			ProviderID: id,
			Capability: capability,
			Parameters: []protocol.Parameter{},
		})
	}
	return protocol.Manifest{
		APIVersion: "beeftv.plugin/v1",
		Metadata: protocol.Metadata{
			ID:            id,
			Version:       "1.0.0",
			Name:          name,
			Vendor:        "内置工作流",
			Description:   description,
			Documentation: "# " + name + "\n\n## 宿主运行时合同\n\n该工作流能力由插件运行时统一管理。",
			Enabled:       false,
			Installable:   true,
		},
		Surfaces:    []string{"node", "settings"},
		Runtime:     protocol.ManifestRuntime{Backend: "trusted-backend", Web: "trusted-backend"},
		Permissions: []string{"generation.run", "external.open"},
		Contributes: protocol.ManifestContributions{Workflows: workflows},
	}
}

func workflowPluginIDForInterface(value string) (string, bool) {
	switch value {
	case "runninghub-workflow-image", "runninghub-workflow-video", "runninghub-workflow-audio":
		return WorkflowPluginRunningHub, true
	case "comfyui-workflow-image", "comfyui-workflow-video":
		return WorkflowPluginComfyUI, true
	default:
		return "", false
	}
}

// workflowPluginDisplayName 用于插件门禁失败时的可读提示。
func workflowPluginDisplayName(pluginID string) string {
	switch pluginID {
	case WorkflowPluginRunningHub:
		return "RunningHub 工作流插件"
	case WorkflowPluginComfyUI:
		return "ComfyUI 工作流插件"
	default:
		return "工作流插件"
	}
}

func (s *Service) WorkflowPluginStatuses() map[string]string {
	ids := bundledWorkflowPluginIDs()
	statuses := make(map[string]string, len(ids))
	for _, pluginID := range ids {
		state, err := s.pluginStateForUser(nil, pluginID, s.Plugins())
		if err == nil && state.PlatformAvailable {
			statuses[pluginID] = "enabled"
		} else {
			statuses[pluginID] = "disabled"
		}
	}
	return statuses
}

func (s *Service) WorkflowPluginStatusesForUser(userID string) (map[string]string, error) {
	ids := bundledWorkflowPluginIDs()
	statuses := make(map[string]string, len(ids))
	actor := &model.User{ID: strings.TrimSpace(userID)}
	for _, pluginID := range ids {
		state, err := s.pluginStateForUser(actor, pluginID, s.Plugins())
		if err != nil {
			return nil, err
		}
		if state.EffectiveEnabled {
			statuses[pluginID] = "enabled"
		} else {
			statuses[pluginID] = "disabled"
		}
	}
	return statuses, nil
}

func (s *Service) RequireWorkflowPluginForInterface(interfaceType string) error {
	pluginID, ok := workflowPluginIDForInterface(normalizeWorkflowInterfaceType(interfaceType))
	if !ok {
		return Forbidden("未知工作流插件")
	}
	status, exists := s.WorkflowPluginStatuses()[pluginID]
	if !exists || status != "enabled" {
		return Forbidden(workflowPluginDisplayName(pluginID) + "未启用")
	}
	return nil
}

func (s *Service) RequireWorkflowPluginForUser(userID string, interfaceType string) error {
	pluginID, ok := workflowPluginIDForInterface(normalizeWorkflowInterfaceType(interfaceType))
	if !ok {
		return Forbidden("未知工作流插件")
	}
	if err := s.RequirePluginForUser(userID, pluginID); err != nil {
		return Forbidden(workflowPluginDisplayName(pluginID) + "未启用")
	}
	return nil
}

func normalizeWorkflowInterfaceType(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	return value
}
