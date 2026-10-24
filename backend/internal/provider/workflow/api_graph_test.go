package workflow

import "testing"

func TestAPIGraphPreservesWidgetTypesAndLinks(t *testing.T) {
	graph := map[string]any{"1": map[string]any{"class_type": "Source", "inputs": map[string]any{"width": 512.0, "enabled": true, "image": []any{"2", 0}}}}
	input := Input{Mode: "image", Config: Config{Size: "1024x768", WorkflowJSON: graph, WorkflowFields: []Field{{NodeID: "1", FieldName: "width", Source: "width", FieldType: "NUMBER"}}}}
	bound, err := BindAPIGraph(input, nil)
	if err != nil {
		t.Fatal(err)
	}
	values := bound["1"].(map[string]any)["inputs"].(map[string]any)
	if values["width"] != 1024.0 {
		t.Fatalf("width type/value incorrect: %#v", values)
	}
	if graph["1"].(map[string]any)["inputs"].(map[string]any)["width"] != 512.0 {
		t.Fatal("mutated saved workflow")
	}
	input.Config.WorkflowFields = []Field{{NodeID: "1", FieldName: "image", Value: "override"}}
	if _, err := BindAPIGraph(input, nil); err == nil {
		t.Fatal("allowed overriding graph link")
	}
}
