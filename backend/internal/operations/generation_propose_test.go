package operations

import (
	"encoding/json"
	"fmt"
	"testing"
)

type proposeProbe struct {
	unusedDomain
	doc     json.RawMessage
	calls   [][2]string
	resolve func(kind, selected string) (AssistantGenerationModel, error)
}

func (p *proposeProbe) UserCanvasProject(string, string) (json.RawMessage, error) {
	return p.doc, nil
}

func (p *proposeProbe) ResolveAssistantGenerationModel(kind, selected string) (AssistantGenerationModel, error) {
	p.calls = append(p.calls, [2]string{kind, selected})
	if p.resolve != nil {
		return p.resolve(kind, selected)
	}
	return AssistantGenerationModel{Display: "gpt-image-2", ModelKey: "beeftv::gpt-image-2", Revision: 1}, nil
}

func proposeCanvas(t *testing.T, nodes []map[string]any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"id": "c1", "revision": 4, "nodes": nodes, "connections": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func imageNode(id, model string) map[string]any {
	metadata := map[string]any{"prompt": id}
	if model != "" {
		metadata["model"] = model
	}
	return map[string]any{"id": id, "type": "image", "title": id, "metadata": metadata}
}

func TestOpGenerationProposeUsesNodeOverrideBeforeDefault(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{
		imageNode("n1", "beeftv::gpt-image-2.5-flare"),
	})}
	probe.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
		if kind != "image" || selected != "beeftv::gpt-image-2.5-flare" {
			t.Fatalf("expected node selection, got kind=%s selected=%s", kind, selected)
		}
		return AssistantGenerationModel{Display: "gpt-image-2.5-flare", ModelKey: selected, Revision: 9}, nil
	}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["model"] != "gpt-image-2.5-flare" || payload["modelKey"] != "beeftv::gpt-image-2.5-flare" {
		t.Fatalf("proposal should use node override: %#v", payload)
	}
	source := payload["source"].(map[string]any)
	if source["modelConfigRevision"] != int64(9) || source["canvasRevision"] != float64(4) {
		t.Fatalf("source binding: %#v", source)
	}
	targets, ok := payload["targets"].([]map[string]any)
	if !ok || len(targets) != 1 || targets[0]["nodeId"] != "n1" || targets[0]["modelKey"] != "beeftv::gpt-image-2.5-flare" || targets[0]["prompt"] != "n1" {
		t.Fatalf("propose should echo targets with effective prompt and model: %#v", payload["targets"])
	}
}

func TestOpGenerationProposeFallsBackToDefaultWithoutNodeModel(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", ""), imageNode("n2", "")})}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n2"],"kind":"image"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["modelKey"] != "beeftv::gpt-image-2" {
		t.Fatalf("empty node model should use default: %#v", payload)
	}
	if len(probe.calls) != 2 || probe.calls[0][1] != "" || probe.calls[1][1] != "" {
		t.Fatalf("should resolve empty selections: %#v", probe.calls)
	}
}

func TestOpGenerationProposeRejectsUnavailableExplicitModel(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", "removed::image")})}
	probe.resolve = func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{Revision: 1}, nil
	}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err == nil || result != nil || AsError(err).Reason != "generation_model_unavailable" {
		t.Fatalf("unavailable explicit model must not produce a paid proposal: result=%v err=%v", result, err)
	}
}

func TestOpGenerationProposeCombinesMixedNodeModelsAndKinds(t *testing.T) {
	audioNode := map[string]any{"id": "n3", "type": "audio", "title": "旁白配音", "metadata": map[string]any{"prompt": "雨夜独白", "model": "beeftv::speech-2.8-hd"}}
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{
		imageNode("n1", "beeftv::gpt-image-2.5-flare"),
		imageNode("n2", ""),
		audioNode,
	})}
	probe.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
		switch {
		case kind == "audio":
			return AssistantGenerationModel{Display: "speech-2.8-hd", ModelKey: "beeftv::speech-2.8-hd", Revision: 1}, nil
		case selected == "beeftv::gpt-image-2.5-flare":
			return AssistantGenerationModel{Display: "gpt-image-2.5-flare", ModelKey: selected, Revision: 1}, nil
		default:
			return AssistantGenerationModel{Display: "gpt-image-2", ModelKey: "beeftv::gpt-image-2", Revision: 1}, nil
		}
	}
	// Multi-model same-kind proposal: combines both image nodes into one card.
	sameKindRaw, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n2"],"kind":"image"}`))
	if err != nil {
		t.Fatalf("multi-model image proposal should succeed: %v", err)
	}
	sameKind := sameKindRaw.(map[string]any)
	if sameKind["kind"] != "image" || sameKind["model"] != "多个模型" || sameKind["modelKey"] != "" {
		t.Fatalf("unexpected multi-model image proposal header: %#v", sameKind)
	}
	sameTargets := sameKind["targets"].([]map[string]any)
	if len(sameTargets) != 2 || sameTargets[0]["modelKey"] != "beeftv::gpt-image-2.5-flare" || sameTargets[1]["modelKey"] != "beeftv::gpt-image-2" {
		t.Fatalf("expected per-target models preserved: %#v", sameTargets)
	}

	// Mixed-kind & multi-model proposal (kind omitted or "mixed"): combines image + audio in one card.
	mixedRaw, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n3"]}`))
	if err != nil {
		t.Fatalf("mixed-kind proposal should succeed: %v", err)
	}
	mixed := mixedRaw.(map[string]any)
	if mixed["kind"] != "mixed" || mixed["model"] != "多个模型" || mixed["modelKey"] != "" {
		t.Fatalf("unexpected mixed-kind proposal header: %#v", mixed)
	}
	mixedTargets := mixed["targets"].([]map[string]any)
	if len(mixedTargets) != 2 || mixedTargets[0]["kind"] != "image" || mixedTargets[1]["kind"] != "audio" || mixedTargets[1]["modelKey"] != "beeftv::speech-2.8-hd" {
		t.Fatalf("expected mixed targets with per-node kind/model: %#v", mixedTargets)
	}
}

func TestOpGenerationProposeRejectsConfigRevisionDrift(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{
		imageNode("n1", "beeftv::gpt-image-2"),
		imageNode("n2", "beeftv::gpt-image-2"),
	})}
	probe.resolve = func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{
			Display:  "gpt-image-2",
			ModelKey: "beeftv::gpt-image-2",
			Revision: int64(len(probe.calls)),
		}, nil
	}
	_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n2"],"kind":"image"}`))
	if err == nil {
		t.Fatal("same model keys with drifted config revision must be rejected")
	}
	opErr := AsError(err)
	if opErr.Reason != "generation_config_changed" || opErr.Code != CodePreconditionFailed {
		t.Fatalf("config revision drift: %v", err)
	}
	if len(probe.calls) != 2 {
		t.Fatalf("both nodes must be resolved before reject: %#v", probe.calls)
	}
}

func TestOpGenerationProposeRejectsKindMismatch(t *testing.T) {
	videoNode := imageNode("n1", "beeftv::wan3.0-video")
	videoNode["type"] = "video"
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{videoNode})}
	_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err == nil {
		t.Fatal("video node must not accept image propose")
	}
	if AsError(err).Reason != "generation_kind_mismatch" {
		t.Fatalf("node kind reason: %v", err)
	}

	probe = &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", "beeftv::wan3.0-video")})}
	probe.resolve = func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{KindMismatch: true}, nil
	}
	_, err = opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err == nil {
		t.Fatal("wrong-kind model must be rejected")
	}
	if AsError(err).Reason != "generation_model_kind_mismatch" {
		t.Fatalf("model kind reason: %v", err)
	}
}

func TestOpGenerationProposeAcceptsLargeBatch(t *testing.T) {
	nodes := make([]map[string]any, 0, 40)
	nodeIDs := make([]string, 0, 40)
	for i := 1; i <= 40; i++ {
		id := fmt.Sprintf("img-%d", i)
		nodes = append(nodes, imageNode(id, "beeftv::gpt-image-2"))
		nodeIDs = append(nodeIDs, id)
	}
	probe := &proposeProbe{doc: proposeCanvas(t, nodes)}
	params, err := json.Marshal(map[string]any{"canvasId": "c1", "nodeIds": nodeIDs, "kind": "image"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, params)
	if err != nil {
		t.Fatalf("一次提议 40 个节点应成功: %v", err)
	}
	payload := result.(map[string]any)
	targets, ok := payload["targets"].([]map[string]any)
	if !ok || len(targets) != 40 {
		t.Fatalf("应返回 40 项提议明细，得到 %d", len(targets))
	}
}
