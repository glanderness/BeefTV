package canvas

import (
	"fmt"
	"testing"
)

func TestSeedreamLayersConnectToSourceAndFitAsOneGrid(t *testing.T) {
	makeNode := func(id string, x, y float64) map[string]any {
		return map[string]any{"id": id, "type": "image", "width": 300.0, "height": 180.0,
			"position": map[string]any{"x": x, "y": y}, "metadata": map[string]any{}}
	}
	source := makeNode("source", 20, 50)
	root := makeNode("background", 416, 50)
	root["metadata"] = map[string]any{"taskId": "split", "seedreamMode": "layers"}
	blocker := makeNode("existing", 770, 280)
	doc := map[string]any{"nodes": []any{source, root, blocker}, "connections": []any{
		map[string]any{"id": "source-link", "fromNodeId": "source", "toNodeId": "background"},
	}}
	outputs := []TaskOutputBind{{NodeID: "background", TaskID: "split", Content: "base"}}
	for i := 1; i <= 5; i++ {
		outputs = append(outputs, TaskOutputBind{NodeID: fmt.Sprintf("layer-%d", i), TaskID: "split", OutputIndex: i, Content: "layer"})
	}
	outputs[3].Width, outputs[3].Height = 320, 640
	if !prepareSeedreamOutputs(doc, "background", "split", outputs, nil) {
		t.Fatal("layer delivery did not update the document")
	}
	links := map[string]int{}
	for _, raw := range doc["connections"].([]any) {
		edge := raw.(map[string]any)
		if edge["fromNodeId"] == "source" {
			links[edge["toNodeId"].(string)]++
		}
	}
	for _, output := range outputs {
		if links[output.NodeID] != 1 {
			t.Errorf("%s has %d links from the source, want 1", output.NodeID, links[output.NodeID])
		}
	}
	positions := make([][2]float64, len(outputs))
	for i, output := range outputs {
		node := findCanvasNode(doc, output.NodeID)
		x, y := seedreamNodePosition(node)
		positions[i] = [2]float64{x, y}
		if x < 320 || seedreamPositionOccupied([]any{source, blocker}, x, y, 300, 180) {
			t.Errorf("%s overlaps an existing node or is left of the source: %v", output.NodeID, positions[i])
		}
	}
	if positions[0][1] != positions[1][1] || positions[1][1] != positions[2][1] ||
		positions[3][1] != positions[4][1] || positions[4][1] != positions[5][1] ||
		positions[3][1] <= positions[0][1] || positions[2][0] <= positions[1][0] || positions[1][0] <= positions[0][0] {
		t.Errorf("expected two rows of three in output order, got %v", positions)
	}
	for i := range 3 {
		if positions[i][0] != positions[i+3][0] {
			t.Errorf("column %d is misaligned: %v", i, positions)
		}
	}
	portrait := findCanvasNode(doc, "layer-3")
	if portrait["width"] != 90.0 || portrait["height"] != 180.0 {
		t.Errorf("portrait must keep its aspect ratio inside the grid, got %v × %v", portrait["width"], portrait["height"])
	}
	// A recovery pass must not override later edits to the delivered layout.
	root["position"] = map[string]any{"x": 42.0, "y": 75.0}
	doc["connections"] = doc["connections"].([]any)[:1]
	if prepareSeedreamOutputs(doc, "background", "split", outputs, nil) {
		t.Fatal("recovery restored manually changed positions or deleted edges")
	}
}

func TestSeedreamOutputsDoNotOverwriteOrResurrect(t *testing.T) {
	doc := map[string]any{"nodes": []any{map[string]any{"id": "root", "title": "original", "type": "image", "position": map[string]any{"x": 0.0, "y": 0.0}, "width": 340.0, "height": 240.0, "metadata": map[string]any{"taskId": "task", "content": "old-last-image"}}}}
	outputs := []TaskOutputBind{{NodeID: "root", TaskID: "task", OutputIndex: 0, Content: "base", EffectKey: "base-effect"}, {NodeID: "derived-1", TaskID: "task", OutputIndex: 1, Content: "transparent-layer", EffectKey: "layer-effect"}}
	layers := map[int]map[string]any{1: {"name": "teapot", "z_index": 1.0, "bounding_box": map[string]any{"absolute": []any{1.0, 2.0, 3.0, 4.0}}}}
	if !prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("not expanded")
	}
	if len(canvasDocNodes(doc)) != 2 || nodeString(nodeMetadata(findCanvasNode(doc, "root")), "content") != "base" {
		t.Fatal("original overwritten")
	}
	child := findCanvasNode(doc, "derived-1")
	if nodeString(nodeMetadata(child), "content") != "transparent-layer" || nodeMetadata(child)["imageLayer"] == nil {
		t.Fatal("layer missing")
	}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("not idempotent")
	}
	doc["nodes"] = []any{findCanvasNode(doc, "root")}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) || len(canvasDocNodes(doc)) != 1 {
		t.Fatal("deleted output resurrected")
	}
	findCanvasNode(doc, "root")["metadata"] = map[string]any{"taskId": "new-task"}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("new request overwritten")
	}
	doc["nodes"] = []any{}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("deleted root recreated")
	}
}

func TestSeedreamLayersDoNotStackOnLockedBackground(t *testing.T) {
	source := map[string]any{"id": "source", "type": "image", "width": 300.0, "height": 180.0}
	root := map[string]any{"id": "background", "type": "image",
		"position": map[string]any{"x": 396.0, "y": 0.0}, "width": 300.0, "height": 180.0,
		"metadata": map[string]any{"taskId": "split", "seedreamMode": "layers", "locked": true, "manualSize": true}}
	doc := map[string]any{"nodes": []any{source, root}, "connections": []any{
		map[string]any{"id": "source-link", "fromNodeId": "source", "toNodeId": "background"},
	}}
	outputs := []TaskOutputBind{
		{NodeID: "background", TaskID: "split", Content: "base"},
		{NodeID: "layer-1", TaskID: "split", OutputIndex: 1, Content: "layer-a"},
		{NodeID: "layer-2", TaskID: "split", OutputIndex: 2, Content: "layer-b"},
	}
	if !prepareSeedreamOutputs(doc, "background", "split", outputs, nil) {
		t.Fatal("layer delivery did not update the document")
	}
	x, y := seedreamNodePosition(root)
	if x != 396 || y != 0 || nodeMetadata(root)["locked"] != true {
		t.Fatal("locked background moved or lost its lock")
	}
	placed := []any{root}
	for _, output := range outputs[1:] {
		node := findCanvasNode(doc, output.NodeID)
		x, y := seedreamNodePosition(node)
		if seedreamPositionOccupied(placed, x, y, 300, 180) || nodeMetadata(node)["locked"] == true {
			t.Errorf("%s overlaps a previous output or inherited its lock", output.NodeID)
		}
		placed = append(placed, node)
	}
}

func TestSeedream55ExpandsUpToDefault30AndMax100LayerOutputs(t *testing.T) {
	doc := map[string]any{"nodes": []any{map[string]any{"id": "root", "title": "poster", "type": "image", "position": map[string]any{"x": 0.0, "y": 0.0}, "width": 340.0, "height": 240.0, "metadata": map[string]any{"taskId": "task-55"}}}}
	outputs := make([]TaskOutputBind, 0, 31)
	outputs = append(outputs, TaskOutputBind{NodeID: "root", TaskID: "task-55", OutputIndex: 0, Content: "base", EffectKey: "effect-0"})
	for i := 1; i < 30; i++ {
		outputs = append(outputs, TaskOutputBind{
			NodeID: fmt.Sprintf("image-output-task-55-%d", i), TaskID: "task-55", OutputIndex: i,
			Content: fmt.Sprintf("layer-%d", i), EffectKey: fmt.Sprintf("effect-%d", i),
		})
	}
	outputs = append(outputs, TaskOutputBind{NodeID: "overflow", TaskID: "task-55", OutputIndex: 100, Content: "ignored", EffectKey: "effect-100"})
	if !prepareSeedreamOutputs(doc, "root", "task-55", outputs, nil) {
		t.Fatal("expected 30 outputs to expand")
	}
	if got := len(canvasDocNodes(doc)); got != 30 {
		t.Fatalf("expected 30 bound nodes (0..29) and index 100 ignored, got %d", got)
	}
	if findCanvasNode(doc, "image-output-task-55-29") == nil || findCanvasNode(doc, "overflow") != nil {
		t.Fatal("expected layer 29 bound and overflow 100 rejected")
	}
}
