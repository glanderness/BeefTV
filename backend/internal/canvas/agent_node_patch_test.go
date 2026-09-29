package canvas

import (
	"encoding/json"
	"testing"
)

// 画布编辑器的提示词输入框读的是 metadata.composerContent（见
// canvas-node-prompt-panel.tsx：composerContent ?? prompt）。因此外部写入必须落到
// 描述符声明的同一路径，否则「外部改提示词」在界面上看不到，还会把生成节点的
// 媒体结果槽位 metadata.content 覆盖掉。
func TestUpdateUserCanvasNodeFieldsFollowsDescriptorPaths(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	actor := "owner"
	canvasID := "canvas-patch-paths"
	created, err := svc.UpsertUserCanvasProject(actor, json.RawMessage(`{
		"id":"canvas-patch-paths","revision":0,"title":"补丁路径",
		"nodes":[
			{"id":"img","type":"image","title":"镜头","metadata":{"content":"","prompt":"已提交提示词","composerContent":"原始草稿","status":"idle"}},
			{"id":"txt","type":"text","title":"文本","metadata":{"content":"正文","status":"idle"}}
		],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, "img", map[string]any{"content": "夜景：雨夜巷口对峙"}, created.Revision); err != nil {
		t.Fatal(err)
	}
	raw, err := svc.UserCanvasProject(actor, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	image := doc.Nodes[0]
	if image.Metadata["composerContent"] != "夜景：雨夜巷口对峙" {
		t.Fatalf("生成节点 content 补丁应落到 composerContent，实际 %#v", image.Metadata)
	}
	if image.Metadata["prompt"] != "已提交提示词" {
		t.Fatalf("content 补丁不得改写已提交提示词，实际 %#v", image.Metadata["prompt"])
	}
	if image.Metadata["content"] != "" {
		t.Fatalf("content 补丁不得覆盖媒体结果槽位，实际 %#v", image.Metadata["content"])
	}

	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, "txt", map[string]any{"content": "新的正文"}, created.Revision+1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateUserCanvasNodeFields(actor, canvasID, "img", map[string]any{"prompt": "重新提交的提示词"}, created.Revision+2); err != nil {
		t.Fatal(err)
	}
	raw, err = svc.UserCanvasProject(actor, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Nodes[1].Metadata["content"] != "新的正文" {
		t.Fatalf("文本节点 content 补丁应落到 content，实际 %#v", doc.Nodes[1].Metadata)
	}
	if doc.Nodes[0].Metadata["prompt"] != "重新提交的提示词" {
		t.Fatalf("prompt 补丁应仍写入 metadata.prompt，实际 %#v", doc.Nodes[0].Metadata["prompt"])
	}
	if doc.Nodes[0].Metadata["composerContent"] != "夜景：雨夜巷口对峙" {
		t.Fatalf("prompt 补丁不得改写编辑器草稿，实际 %#v", doc.Nodes[0].Metadata["composerContent"])
	}
}
