package agentops_test

import (
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

// 付费生成只提议不执行：这个操作必须是只读的（不碰画布、不扣费），
// 并且只接受确实属于本画布的节点，否则模型可以借它把别处的对象写进提议。
func writeGenerationModels(t *testing.T, dataDir string) {
	t.Helper()
	body := `{"schemaVersion":1,"revision":1,"config":{"imageModel":"beefapi::gpt-image-2","videoModel":"beefapi::wan3.0-video"}}`
	if err := os.WriteFile(filepath.Join(dataDir, "local-model-config.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestGenerationProposeIsReadOnlyAndReportsCanvasDefaultModel(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)

	descriptor, found := h.registry.Descriptor("canvas.generation.propose")
	if !found {
		t.Fatal("canvas.generation.propose 未注册")
	}
	if !descriptor.ReadOnly {
		t.Fatal("生成提议不应被登记为写操作：它不写画布也不扣费")
	}

	result, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1", "n2"}, "kind": "image", "note": "做两张分镜图"}, false)
	if err != nil {
		t.Fatalf("提议应成功: %v", err)
	}
	payload, isObject := result.Result.(map[string]any)
	if !isObject {
		t.Fatalf("结果形状异常: %#v", result.Result)
	}
	if payload["model"] != "gpt-image-2" || payload["modelKey"] != "beefapi::gpt-image-2" {
		t.Fatalf("应回画布默认图片模型: %#v", payload)
	}
	if payload["kind"] != "image" || payload["note"] != "做两张分镜图" {
		t.Fatalf("提议内容异常: %#v", payload)
	}
	if id, _ := payload["proposalId"].(string); id == "" {
		t.Fatal("提议必须有稳定标识")
	}
	nodeIDs, _ := payload["nodeIds"].([]any)
	if len(nodeIDs) != 2 {
		t.Fatalf("节点列表异常: %#v", payload["nodeIds"])
	}
	// 画布内容不能被提议改动。
	after, err := h.run(t, "canvas.get", "", map[string]any{"canvasId": h.canvasID}, true)
	if err != nil {
		t.Fatal(err)
	}
	canvas, _ := after.Result.(map[string]any)["canvas"].(map[string]any)
	if got, _ := canvas["revision"].(float64); int64(got) != h.revision {
		t.Fatalf("提议不应推进画布版本：%d → %v", h.revision, canvas["revision"])
	}
}

func TestGenerationProposeRejectsForeignNodesAndBadInput(t *testing.T) {
	h := newHarness(t)
	writeGenerationModels(t, h.dataDir)

	cases := []struct {
		name   string
		params map[string]any
	}{
		{"节点不属于本画布", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{"n1", "ghost"}, "kind": "image"}},
		{"未知类型", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "audio"}},
		{"空节点列表", map[string]any{"canvasId": h.canvasID, "nodeIds": []any{}, "kind": "image"}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if _, err := h.run(t, "canvas.generation.propose", "", item.params, false); err == nil {
				t.Fatal("应被拒绝")
			} else if code := opCode(t, err); code != agentops.CodeInvalidArgument {
				t.Fatalf("应是参数错误，得到 %v", code)
			}
		})
	}
}

// 没有配置默认生成模型时必须明确失败：不能给出一个用户无法执行的提议。
func TestGenerationProposeFailsWithoutCanvasDefaultModel(t *testing.T) {
	h := newHarness(t)

	_, err := h.run(t, "canvas.generation.propose", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "video"}, false)
	if err == nil {
		t.Fatal("没有默认视频模型时应失败")
	}
	if reason := agentops.AsError(err).Reason; reason != "generation_model_not_configured" {
		t.Fatalf("reason 应为 generation_model_not_configured，得到 %q", reason)
	}
}
