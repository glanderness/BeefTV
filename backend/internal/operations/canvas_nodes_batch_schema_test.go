package operations

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"infinite-canvas/backend/internal/canvas/capability"
)

func TestCanvasNodesBatchSchemasAndPolicy(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)

	configure := registry.ops["canvas.nodes.configure"]
	if configure == nil || configure.ExternalOnly || configure.ReadOnly || !configure.AssistantCanvas || !configure.ReplaySafe {
		t.Fatalf("canvas.nodes.configure 策略不正确: %#v", configure)
	}
	if !configure.AssistantVisible("canvas") || !configure.AssistantVisible("full-access") || configure.AssistantVisible("read-only") {
		t.Fatal("批量配置应对画布与完全访问模式的内置助手开放，且只读模式不可见")
	}
	get := registry.ops["canvas.nodes.get"]
	if get == nil || get.ExternalOnly || !get.ReadOnly || !get.AssistantCanvas {
		t.Fatalf("canvas.nodes.get 策略不正确: %#v", get)
	}
	if !get.AssistantVisible("canvas") || !get.AssistantVisible("full-access") || !get.AssistantVisible("read-only") {
		t.Fatal("批量读取应对内置助手各模式开放")
	}

	descriptor, _ := registry.Descriptor("canvas.nodes.configure")
	var schema jsonschema.Schema
	if err := json.Unmarshal(descriptor.Params, &schema); err != nil {
		t.Fatal(err)
	}
	nodes := schema.Properties["nodes"]
	if nodes == nil || nodes.MaxItems != nil || nodes.MinItems == nil || *nodes.MinItems != 1 {
		t.Fatalf("批量配置 nodes 应只要求 minItems=1 且无人为上限: %#v", nodes)
	}
	item := nodes.Items
	if item == nil {
		t.Fatal("批量配置缺少节点 schema")
	}
	for _, kind := range []string{"image", "video", "audio"} {
		media, _ := capability.BuiltinRegistry().Resolve(kind)
		for name := range media.PatchFields {
			if name == "title" || name == "content" {
				continue
			}
			if item.Properties["patch"].Properties[name] == nil {
				t.Errorf("%s 字段 %q 没有进入批量配置 schema", kind, name)
			}
		}
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	valid := map[string]any{"canvasId": "c1", "expectedRevision": 1, "operationId": "batch-1",
		"nodes": []any{map[string]any{"nodeId": "n1", "kind": "image", "patch": map[string]any{"prompt": "草稿"}}}}
	if err := resolved.Validate(valid); err != nil {
		t.Fatalf("合法批量配置被拒绝: %v", err)
	}
	valid["nodes"] = make([]any, 50)
	for index := range valid["nodes"].([]any) {
		valid["nodes"].([]any)[index] = map[string]any{"nodeId": "n", "kind": "image", "patch": map[string]any{"prompt": "草稿"}}
	}
	if err := resolved.Validate(valid); err != nil {
		t.Fatalf("schema 不应再限制大批量配置: %v", err)
	}

	var getSchema jsonschema.Schema
	if err := json.Unmarshal(get.Params, &getSchema); err != nil {
		t.Fatal(err)
	}
	nodeIDs := getSchema.Properties["nodeIds"]
	if nodeIDs == nil || nodeIDs.MaxItems != nil || nodeIDs.MinItems == nil || *nodeIDs.MinItems != 1 {
		t.Fatalf("批量读取 nodeIds 应只要求 minItems=1 且无人为上限: %#v", nodeIDs)
	}
	readResolved, err := getSchema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := readResolved.Validate(map[string]any{"canvasId": "c1", "nodeIds": []any{"n1", "n2"}}); err != nil {
		t.Fatalf("合法批量读取被拒绝: %v", err)
	}
}
