package workflow

import "testing"

func TestNativeTargetDynamicSaveVideoFields(t *testing.T) {
	combo := func(options ...any) []any { return []any{"COMBO", map[string]any{"options": options}} }
	nodes := map[string]any{"SaveVideo": map[string]any{"input": map[string]any{"required": map[string]any{
		"format": []any{"COMFY_DYNAMICCOMBO_V3", map[string]any{"options": []any{
			map[string]any{"key": "mp4", "inputs": map[string]any{"required": map[string]any{"codec": combo("auto", "h264")}}},
			map[string]any{"key": "webm", "inputs": map[string]any{"required": map[string]any{"codec": combo("auto", "av1")}}},
		}}},
	}}}}
	values := map[string]any{"format": "mp4", "format.codec": "h264"}
	graph := map[string]any{"save": map[string]any{"class_type": "SaveVideo", "inputs": values}}
	if err := validateNativeComfyTarget(graph, nil, nodes); err != nil {
		t.Fatal(err)
	}
	values["format.codec"] = "av1"
	if err := validateNativeComfyTarget(graph, nil, nodes); err == nil {
		t.Fatal("accepted codec from a different selected container")
	}
	values["format"] = "webm"
	if err := validateNativeComfyTarget(graph, nil, nodes); err != nil {
		t.Fatal(err)
	}
	values["format"] = "invalid"
	if err := validateNativeComfyTarget(graph, nil, nodes); err == nil {
		t.Fatal("accepted invalid dynamic combo key")
	}
}
