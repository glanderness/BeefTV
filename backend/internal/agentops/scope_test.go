package agentops_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/operations"
)

// 内置助手的范围裁决：当前画布可读写，显式引用/画布关联的素材与任务只读，
// 额外画布只读，跨画布写一律拒绝。模型自报的参数无法越过这里。
func TestAssistantScopeAllowsOnlyVerifiedResources(t *testing.T) {
	scope := &agentops.AssistantScope{
		CanvasID:    "canvas-a",
		AssetIDs:    map[string]bool{"asset-ref": true},
		CanvasIDs:   map[string]bool{"canvas-b": true},
		ResourceIDs: map[string]bool{"res-doc": true},
		TaskIDs:     map[string]bool{"task-1": true},
	}
	cases := []struct {
		name   string
		op     string
		params string
		denied bool
	}{
		{"当前画布可读", "canvas.get", `{"canvasId":"canvas-a"}`, false},
		{"显式引用的画布可读", "canvas.get", `{"canvasId":"canvas-b"}`, false},
		{"未引用的画布不可读", "canvas.get", `{"canvasId":"canvas-c"}`, true},
		{"当前画布批量节点可读", "canvas.nodes.get", `{"canvasId":"canvas-a","nodeIds":["n1"]}`, false},
		{"显式引用的画布批量节点可读", "canvas.nodes.get", `{"canvasId":"canvas-b","nodeIds":["n1"]}`, false},
		{"未引用的画布批量节点不可读", "canvas.nodes.get", `{"canvasId":"canvas-c","nodeIds":["n1"]}`, true},
		{"当前画布可写", "canvas.nodes.create", `{"canvasId":"canvas-a"}`, false},
		{"额外画布不可写", "canvas.nodes.create", `{"canvasId":"canvas-b"}`, true},
		{"当前画布可批量配置", "canvas.nodes.configure", `{"canvasId":"canvas-a"}`, false},
		{"额外画布不可批量配置", "canvas.nodes.configure", `{"canvasId":"canvas-b"}`, true},
		{"当前分镜可追加", "canvas.script.rows.append", `{"canvasId":"canvas-a"}`, false},
		{"额外分镜不可追加", "canvas.script.rows.append", `{"canvasId":"canvas-b"}`, true},
		{"额外分镜不可修改", "canvas.script.row.update", `{"canvasId":"canvas-b"}`, true},
		{"额外分镜不可删除", "canvas.script.row.remove", `{"canvasId":"canvas-b"}`, true},
		{"当前时间线可写", "canvas.timeline.update", `{"canvasId":"canvas-a"}`, false},
		{"额外时间线不可写", "canvas.timeline.update", `{"canvasId":"canvas-b"}`, true},
		{"引用素材可读", "asset.get", `{"assetId":"asset-ref"}`, false},
		{"未引用素材不可读", "asset.get", `{"assetId":"asset-other"}`, true},
		{"当前节点媒体可检查", "media.overview", `{"canvasId":"canvas-a","nodeId":"node-a"}`, false},
		{"关联素材媒体可检查", "media.check", `{"canvasId":"canvas-a","assetId":"asset-ref"}`, false},
		{"未引用媒体不可检查", "media.inspect", `{"canvasId":"canvas-a","assetId":"asset-other"}`, true},
		{"额外画布媒体不可检查", "media.overview", `{"canvasId":"canvas-b","nodeId":"node-b"}`, true},
		{"当前节点可委托审片", "media.review", `{"canvasId":"canvas-a","nodeId":"node-a"}`, false},
		{"关联素材可委托审片", "media.review", `{"canvasId":"canvas-a","assetId":"asset-ref"}`, false},
		{"未引用素材不可委托审片", "media.review", `{"canvasId":"canvas-a","assetId":"asset-other"}`, true},
		{"额外画布不可委托审片", "media.review", `{"canvasId":"canvas-b","nodeId":"node-b"}`, true},
		{"审片来源不可歧义", "media.review", `{"canvasId":"canvas-a","nodeId":"node-a","assetId":"asset-ref"}`, true},
		{"审片来源不可缺失", "media.review", `{"canvasId":"canvas-a"}`, true},
		{"关联任务可读", "task.get", `{"taskId":"task-1"}`, false},
		{"无关任务不可读", "task.get", `{"taskId":"task-2"}`, true},
		{"关联任务可取消", "task.cancel", `{"taskId":"task-1"}`, false},
		{"无关任务不可取消", "task.cancel", `{"taskId":"task-2"}`, true},
		{"关联任务可等待", "task.wait", `{"taskIds":["task-1"]}`, false},
		{"含无关任务不可等待", "task.wait", `{"taskIds":["task-1","task-2"]}`, true},
		{"附带文件可读", "file.read", `{"resourceId":"res-doc"}`, false},
		{"未附带文件不可读", "file.read", `{"resourceId":"res-other"}`, true},
		{"当前画布允许原地重做提议校验", "canvas.generation.regenerate", `{"canvasId":"canvas-a","nodeIds":["n1"]}`, false},
		{"额外画布不可原地重做", "canvas.generation.regenerate", `{"canvasId":"canvas-b","nodeIds":["n1"]}`, true},
		{"画布模式素材库只读列表可用", "asset.list", `{}`, false},
		{"画布模式画布搜索可用", "canvas.search", `{}`, false},
		{"画布模式费用估算可用", "generation.estimate", `{"targets":[{"modelKey":"k","kind":"image"}]}`, false},
		{"整页文档提交不可用", "canvas.document.commit", `{"canvasId":"canvas-a"}`, true},
		{"画布模式新建画布不可用", "canvas.create", `{"title":"x"}`, true},
		{"画布模式底层接口列举不可用", "business.list", `{}`, true},
		{"画布模式底层接口调用不可用", "business.call", `{"tool":"business_get_assets"}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := scope.Allows(registeredScopeOp(t, tc.op), json.RawMessage(tc.params))
			if tc.denied {
				if err == nil {
					t.Fatal("越界调用必须被拒绝")
				}
				if opErr := agentops.AsError(err); opErr.Code != agentops.CodePermissionDenied || opErr.Reason != "scope_denied" {
					t.Fatalf("拒绝原因应为 permission_denied/scope_denied，得到 %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("范围内的调用不应被拒绝: %v", err)
			}
		})
	}
}

func registeredScopeOp(t *testing.T, id string) *agentops.Op {
	t.Helper()
	registry := operations.NewRegistry(nil, nil)
	operations.RegisterDefaultOps(registry)
	descriptor, ok := registry.Descriptor(id)
	if !ok {
		t.Fatalf("unregistered operation %s", id)
	}
	op := &agentops.Op{ID: id, ReadOnly: descriptor.ReadOnly, Scope: descriptor.Scope}
	hasReadOnly := false
	hasFullAccess := false
	for _, mode := range descriptor.AssistantModes {
		if mode == "canvas" {
			op.AssistantCanvas = true
		}
		if mode == "read-only" {
			hasReadOnly = true
		}
		if mode == "full-access" {
			hasFullAccess = true
		}
	}
	if len(descriptor.AssistantModes) == 0 && descriptor.Scope != operations.ScopeConversation {
		op.ExternalOnly = true
	}
	if len(descriptor.AssistantModes) == 1 && hasFullAccess && !op.AssistantCanvas && !hasReadOnly {
		op.FullAccessOnly = true
	}
	if descriptor.ReadOnly && !hasReadOnly && !op.FullAccessOnly {
		op.AssistantProposal = true
	}
	return op
}

// 没有绑定画布的空范围（宿主在回合之外做能力发现时）不允许执行任何操作。
func TestEmptyAssistantScopeDeniesExecution(t *testing.T) {
	scope := &agentops.AssistantScope{}
	if err := scope.Allows(&agentops.Op{ID: "canvas.get"}, json.RawMessage(`{"canvasId":"canvas-a"}`)); err == nil {
		t.Fatal("空范围不应允许任何执行")
	}
}

// 能力发现的可见集合是真实过滤：不因调用方是助手就暴露工作区级操作。
func TestAssistantVisibleSetExcludesWorkspaceWideOps(t *testing.T) {
	registry := agentops.NewRegistry(nil, nil)
	agentops.RegisterDefaultOps(registry)
	visible := map[string]bool{}
	for _, descriptor := range registry.List(agentops.AssistantCaller(&agentops.AssistantScope{}, false)) {
		visible[descriptor.ID] = true
	}
	for _, id := range []string{"canvas.get", "canvas.node.update", "canvas.nodes.create", "canvas.edge.create",
		"canvas.generation.propose", "canvas.generation.regenerate", "canvas.task.bind", "asset.get", "asset.list", "canvas.search", "generation.estimate", "task.get", "task.cancel", "file.read"} {
		if !visible[id] {
			t.Fatalf("助手应能看到 %s: %v", id, visible)
		}
	}
	for _, id := range []string{"canvas.create", "canvas.document.commit", "conversation.message.attach", "business.list", "business.call"} {
		if visible[id] {
			t.Fatalf("工作区级或整页写操作 %s 不应暴露给 canvas 模式助手", id)
		}
	}
	// 外部客户端（不带助手范围）仍然能看到完整工作区能力，但不重复暴露仅给内置助手的 business.list/call。
	full := registry.List(agentops.Caller{})
	if len(full) <= len(visible) {
		t.Fatalf("外部客户端应看到完整能力集: %d <= %d", len(full), len(visible))
	}
	foundWait := false
	for _, descriptor := range full {
		if descriptor.ID == "task.wait" {
			foundWait = true
		}
		if descriptor.ID == "business.list" || descriptor.ID == "business.call" {
			t.Fatalf("外部客户端不应重复暴露内置助手专用操作 %s", descriptor.ID)
		}
	}
	if !foundWait {
		t.Fatalf("外部客户端应能看到 task.wait: %v", visible)
	}
}

// full-access 模式可以看到 canvas.create、business.list 和 business.call；canvas/read-only 看不到。
func TestFullAccessAssistantSeesCreateAndBusinessGateway(t *testing.T) {
	registry := agentops.NewRegistry(nil, nil)
	agentops.RegisterDefaultOps(registry)
	for _, mode := range []string{"canvas", "read-only"} {
		for _, descriptor := range registry.List(agentops.AssistantCaller(&agentops.AssistantScope{PermissionMode: mode}, false)) {
			if descriptor.ID == "canvas.create" || descriptor.ID == "business.list" || descriptor.ID == "business.call" {
				t.Fatalf("%s 模式不应看到 %s", mode, descriptor.ID)
			}
		}
	}
	fullVisible := map[string]bool{}
	for _, descriptor := range registry.List(agentops.AssistantCaller(&agentops.AssistantScope{PermissionMode: "full-access"}, false)) {
		fullVisible[descriptor.ID] = true
	}
	for _, id := range []string{"canvas.create", "business.list", "business.call", "file.read", "task.cancel", "task.wait", "canvas.generation.regenerate"} {
		if !fullVisible[id] {
			t.Fatalf("full-access 模式应能看到 %s", id)
		}
	}
}

func TestNilAssistantScopeDoesNotFilterCatalog(t *testing.T) {
	registry := agentops.NewRegistry(nil, nil)
	agentops.RegisterDefaultOps(registry)
	var typedNil *agentops.AssistantScope
	listed := registry.List(agentops.Caller{Kind: agentops.CallerManual, Scope: typedNil})
	if len(listed) != 59 {
		t.Fatalf("空指针范围不应收窄目录，得到 %d", len(listed))
	}
	empty := registry.List(agentops.AssistantCaller(&agentops.AssistantScope{}, false))
	if len(empty) != 50 {
		t.Fatalf("空助手范围应只露出助手集合，得到 %d", len(empty))
	}
	if got := registry.List(agentops.AssistantCaller(nil, false)); len(got) != 0 {
		t.Fatalf("助手缺少范围时能力发现必须为空，得到 %d", len(got))
	}
}

func TestReferenceBindingCatalogPermissionModes(t *testing.T) {
	registry := agentops.NewRegistry(nil, nil)
	agentops.RegisterDefaultOps(registry)
	for mode, want := range map[string]int{"read-only": 24, "canvas": 50, "full-access": 54} {
		descriptors := registry.List(agentops.AssistantCaller(&agentops.AssistantScope{PermissionMode: mode}, false))
		if len(descriptors) != want {
			t.Fatalf("%s catalog=%d want=%d", mode, len(descriptors), want)
		}
		bound := false
		for _, d := range descriptors {
			if d.ID == "canvas.node.bind_asset" {
				bound = true
			}
		}
		if bound != (mode != "read-only") {
			t.Fatalf("%s binding visibility=%v", mode, bound)
		}
	}
}
