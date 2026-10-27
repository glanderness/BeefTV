package operations

import (
	"encoding/json"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/canvas/capability"
)

type configureProbe struct {
	proposeProbe
	writes int
}

func (p *configureProbe) UpdateUserCanvasNodeFields(_ string, _ string, nodeID string, patch map[string]any, expected int64) (canvas.UserDataSummary, error) {
	var doc map[string]any
	json.Unmarshal(p.doc, &doc)
	node := findDocNode(doc, nodeID)
	descriptor, _ := capability.BuiltinRegistry().Resolve(node["type"].(string))
	if err := descriptor.ApplyPatch(node, patch); err != nil {
		return canvas.UserDataSummary{}, err
	}
	doc["revision"] = expected + 1
	p.doc, _ = json.Marshal(doc)
	p.writes++
	return canvas.UserDataSummary{Revision: expected + 1}, nil
}
func configureFixture(t *testing.T, kind string) *configureProbe {
	p := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": kind, "title": "keep",
		"metadata": map[string]any{"prompt": "submitted", "composerContent": "draft", "taskId": "existing", "status": "success", "custom": "keep"}}})}}
	return p
}
func TestConfigurePreservesExistingMediaAndValidatesModelSelection(t *testing.T) {
	for kind, patch := range map[string]map[string]any{
		"image": {"model": "chosen", "size": "16:9", "quality": "high", "count": 2, "transparentBackground": "false"},
		"video": {"model": "chosen", "size": "16:9", "seconds": "10", "vquality": "720p", "generateAudio": "true", "watermark": "false"},
		"audio": {"model": "chosen", "audioVoice": "narrator", "audioFormat": "wav", "audioSpeed": "1.25", "audioPitch": "-2", "audioVolume": "0", "audioInstructions": "warm"},
	} {
		t.Run(kind, func(t *testing.T) {
			p := configureFixture(t, kind)
			p.resolve = func(gotKind, selected string) (AssistantGenerationModel, error) {
				if gotKind != kind || selected != "chosen" {
					t.Fatal("wrong model lookup")
				}
				return AssistantGenerationModel{Display: "available", ModelKey: "channel::chosen"}, nil
			}
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": kind, "expectedRevision": 4, "patch": patch})
			result, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw)
			if err != nil {
				t.Fatal(err)
			}
			metadata := result.(map[string]any)["node"].(map[string]any)["metadata"].(map[string]any)
			for key, value := range map[string]any{"prompt": "submitted", "composerContent": "draft", "taskId": "existing", "status": "success", "custom": "keep"} {
				if metadata[key] != value {
					t.Fatalf("overwrote %s", key)
				}
			}
			if metadata["model"] != "channel::chosen" || p.writes != 1 {
				t.Fatal("model not canonical")
			}
		})
	}
}

type seedreamSizePrepareProbe struct {
	unusedDomain
	prepared int
}

func (p *seedreamSizePrepareProbe) ResolveAssistantGenerationModel(_, selected string) (AssistantGenerationModel, error) {
	return AssistantGenerationModel{Display: selected, ModelKey: selected, Revision: 1}, nil
}

func (p *seedreamSizePrepareProbe) PrepareUserCanvasStoryboard(string, string, string, canvas.StoryboardPreparation, int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error) {
	p.prepared++
	return canvas.UserDataSummary{Revision: 5}, canvas.StoryboardPreparationResult{}, nil
}

func (p *seedreamSizePrepareProbe) UserCanvasProject(string, string) (json.RawMessage, error) {
	return json.Marshal(map[string]any{"id": "c1", "revision": 5, "nodes": []any{}, "connections": []any{}})
}

// 尺寸预检要在配置、分镜准备和提案三个真实入口都生效，并按型号区分合法值。
func TestConfigurePrepareAndProposeValidateSeedreamSizes(t *testing.T) {
	const model = "doubao-seedream-4-5-251128"
	key := "beefapi::" + model
	resolve := func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{Display: model, ModelKey: key, Revision: 1}, nil
	}

	t.Run("configure with model in patch", func(t *testing.T) {
		for _, size := range []string{"2K", "4K", "16:9", "5504x3040"} {
			p := configureFixture(t, "image")
			p.resolve = resolve
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"model": model, "size": size}})
			if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err != nil || p.writes != 1 {
				t.Fatalf("size %q should be accepted, err=%v writes=%d", size, err, p.writes)
			}
		}
		for _, size := range []string{"1K", "1500x1500", "1080p"} {
			p := configureFixture(t, "image")
			p.resolve = resolve
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"model": model, "size": size}})
			_, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw)
			if err == nil || AsError(err).Reason != "invalid_parameter" || p.writes != 0 {
				t.Fatalf("size %q should be rejected at configure, err=%v writes=%d", size, err, p.writes)
			}
		}
	})

	t.Run("configure with model already on the node", func(t *testing.T) {
		node := func() map[string]any {
			return map[string]any{"id": "n", "type": "image", "title": "keep", "metadata": map[string]any{"prompt": "draft", "model": model}}
		}
		valid := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{node()})}}
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"size": "4K"}})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: valid}, raw); err != nil || valid.writes != 1 {
			t.Fatalf("node model size should be accepted, err=%v writes=%d", err, valid.writes)
		}
		invalid := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{node()})}}
		raw, _ = json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"size": "1K"}})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: invalid}, raw); err == nil || invalid.writes != 0 {
			t.Fatalf("node model size should be rejected, err=%v writes=%d", err, invalid.writes)
		}
	})

	t.Run("prepare", func(t *testing.T) {
		params := func(size string) json.RawMessage {
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "expectedRevision": 4,
				"script": map[string]any{"title": "作品", "rows": []any{map[string]any{"plotDescription": "开场"}}},
				"image":  map[string]any{"model": model, "size": size}})
			return raw
		}
		accepted := &seedreamSizePrepareProbe{}
		if _, err := opStoryboardPrepare(&Context{UserID: "owner", Domain: accepted}, params("16:9")); err != nil || accepted.prepared != 1 {
			t.Fatalf("valid size should reach prepare, err=%v prepared=%d", err, accepted.prepared)
		}
		rejected := &seedreamSizePrepareProbe{}
		if _, err := opStoryboardPrepare(&Context{UserID: "owner", Domain: rejected}, params("1K")); err == nil || rejected.prepared != 0 {
			t.Fatalf("invalid size should be rejected before prepare, err=%v prepared=%d", err, rejected.prepared)
		}
	})

	t.Run("propose", func(t *testing.T) {
		propose := func(size string) (*proposeProbe, error) {
			p := &proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": "image", "title": "n", "metadata": map[string]any{"prompt": "草稿", "model": model, "size": size}}})}
			p.resolve = resolve
			_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n"],"kind":"image","productionNodeIds":["n"]}`))
			return p, err
		}
		if _, err := propose("4K"); err != nil {
			t.Fatalf("valid size should be proposed, err=%v", err)
		}
		if _, err := propose("1K"); err == nil || AsError(err).Reason != "invalid_parameter" {
			t.Fatalf("invalid size should be rejected at propose, err=%v", err)
		}
	})
}

func TestConfigureRejectsForeignKindUnknownFieldsAndMalformedValues(t *testing.T) {
	for _, target := range []struct{ nodeID, kind string }{{"n", "audio"}, {"missing", "video"}} {
		p := configureFixture(t, "video")
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": target.nodeID, "kind": target.kind, "expectedRevision": 4, "patch": map[string]any{"model": "chosen"}})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err == nil || p.writes != 0 {
			t.Fatal("missing or mismatched target accepted")
		}
	}
	for _, patch := range []map[string]any{{"taskId": "new"}, {"content": "overwrite"}, {"audioSpeed": "1"}, {"seconds": "NaN"}, {"seconds": "0"}, {"generateAudio": true}, {"watermark": "yes"}, {"model": nil}, {"quality": "wrongkind"}, {"count": 9}} {
		p := configureFixture(t, "video")
		before := append(json.RawMessage{}, p.doc...)
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "video", "expectedRevision": 4, "patch": patch})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err == nil {
			t.Fatalf("accepted %+v", patch)
		}
		if p.writes != 0 || !reflect.DeepEqual(before, p.doc) {
			t.Fatal("invalid patch changed canvas")
		}
	}
	for _, choice := range []AssistantGenerationModel{{KindMismatch: true}, {}} {
		p := configureFixture(t, "image")
		p.resolve = func(string, string) (AssistantGenerationModel, error) { return choice, nil }
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeId":"n","kind":"image","expectedRevision":4,"patch":{"model":"unavailable"}}`)); err == nil || p.writes != 0 {
			t.Fatal("unavailable or wrong-kind model accepted")
		}
	}
}
