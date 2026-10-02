package agentops_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

// 内置助手的范围裁决：当前画布可读写，显式引用/画布关联的素材与任务只读，
// 额外画布只读，跨画布写一律拒绝。模型自报的参数无法越过这里。
func TestAssistantScopeAllowsOnlyVerifiedResources(t *testing.T) {
	scope := &agentops.AssistantScope{
		CanvasID:  "canvas-a",
		AssetIDs:  map[string]bool{"asset-ref": true},
		CanvasIDs: map[string]bool{"canvas-b": true},
		TaskIDs:   map[string]bool{"task-1": true},
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
		{"当前画布可写", "canvas.nodes.create", `{"canvasId":"canvas-a"}`, false},
		{"额外画布不可写", "canvas.nodes.create", `{"canvasId":"canvas-b"}`, true},
		{"引用素材可读", "asset.get", `{"assetId":"asset-ref"}`, false},
		{"未引用素材不可读", "asset.get", `{"assetId":"asset-other"}`, true},
		{"关联任务可读", "task.get", `{"taskId":"task-1"}`, false},
		{"无关任务不可读", "task.get", `{"taskId":"task-2"}`, true},
		{"工作区级列举不可用", "asset.list", `{}`, true},
		{"整页文档提交不可用", "canvas.document.commit", `{"canvasId":"canvas-a"}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := scope.Allows(&agentops.Op{ID: tc.op}, json.RawMessage(tc.params))
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
		"canvas.generation.propose", "canvas.task.bind", "asset.get", "task.get"} {
		if !visible[id] {
			t.Fatalf("助手应能看到 %s: %v", id, visible)
		}
	}
	for _, id := range []string{"asset.list", "canvas.search", "canvas.document.commit", "conversation.message.attach"} {
		if visible[id] {
			t.Fatalf("工作区级或整页写操作 %s 不应暴露给助手", id)
		}
	}
	// 外部客户端（不带助手范围）仍然能看到完整工作区能力。
	full := registry.List(agentops.Caller{})
	if len(full) <= len(visible) {
		t.Fatalf("外部客户端应看到完整能力集: %d <= %d", len(full), len(visible))
	}
}

func TestNilAssistantScopeDoesNotFilterCatalog(t *testing.T) {
	registry := agentops.NewRegistry(nil, nil)
	agentops.RegisterDefaultOps(registry)
	var typedNil *agentops.AssistantScope
	listed := registry.List(agentops.Caller{Kind: agentops.CallerManual, Scope: typedNil})
	if len(listed) != 12 {
		t.Fatalf("空指针范围不应收窄目录，得到 %d", len(listed))
	}
	empty := registry.List(agentops.AssistantCaller(&agentops.AssistantScope{}, false))
	if len(empty) != 8 {
		t.Fatalf("空助手范围应只露出助手集合，得到 %d", len(empty))
	}
	if got := registry.List(agentops.AssistantCaller(nil, false)); len(got) != 0 {
		t.Fatalf("助手缺少范围时能力发现必须为空，得到 %d", len(got))
	}
}
