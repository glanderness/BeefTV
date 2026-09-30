package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// objectInfoFixture 复刻真实 ComfyUI /object_info 的字段形状（0.37 实测）：
// required 的每个输入是 [类型, 选项] 两元数组，枚举的「类型」位置是数组本身。
const objectInfoFixture = `{
  "CLIPTextEncode": {
    "input": {
      "required": {
        "text": ["STRING", {"multiline": true, "dynamicPrompts": true}],
        "clip": ["CLIP", {"tooltip": "The CLIP model used for encoding the text."}]
      }
    },
    "input_order": {"required": ["text", "clip"]},
    "name": "CLIPTextEncode",
    "display_name": "CLIP Text Encode (Prompt)",
    "category": "model/conditioning"
  },
  "KSampler": {
    "input": {
      "required": {
        "seed": ["INT", {"default": 0, "min": 0, "max": 18446744073709551615}],
        "sampler_name": [["euler", "dpmpp_2m"], {"tooltip": "sampler"}],
        "positive": ["CONDITIONING", {"tooltip": "positive"}]
      },
      "optional": {
        "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}]
      }
    },
    "input_order": {"required": ["seed", "sampler_name", "positive"], "optional": ["denoise"]},
    "name": "KSampler",
    "display_name": "KSampler",
    "category": "sampling"
  }
}`

func TestComfyUIObjectNodeMarksLinkInputsAndKeepsOrder(t *testing.T) {
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(objectInfoFixture), &payload); err != nil {
		t.Fatal(err)
	}
	node := comfyUIObjectNode("CLIPTextEncode", payload["CLIPTextEncode"].(map[string]interface{}))
	if node.DisplayName != "CLIP Text Encode (Prompt)" || node.Category != "model/conditioning" {
		t.Fatalf("节点元信息缺失：%#v", node)
	}
	if len(node.Inputs) != 2 {
		t.Fatalf("输入数量 = %d, want 2：%#v", len(node.Inputs), node.Inputs)
	}
	// 必须保持 input_order，方便界面按节点源码顺序展示字段。
	if node.Inputs[0].Name != "text" || node.Inputs[1].Name != "clip" {
		t.Fatalf("输入顺序未按 input_order：%#v", node.Inputs)
	}
	text := node.Inputs[0]
	if text.Type != "STRING" || text.Link || !text.Multiline || !text.Required {
		t.Fatalf("STRING 输入解析错误：%#v", text)
	}
	// CLIP 只能由上游连线提供，必须标记为连线输入，避免字段映射拆坏工作流拓扑。
	clip := node.Inputs[1]
	if !clip.Link || clip.Type != "CLIP" {
		t.Fatalf("连线输入未被标记：%#v", clip)
	}
}

func TestComfyUIObjectNodeParsesEnumsAndNumericBounds(t *testing.T) {
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(objectInfoFixture), &payload); err != nil {
		t.Fatal(err)
	}
	node := comfyUIObjectNode("KSampler", payload["KSampler"].(map[string]interface{}))
	byName := map[string]ComfyUIObjectInput{}
	for _, input := range node.Inputs {
		byName[input.Name] = input
	}
	if len(node.Inputs) != 4 {
		t.Fatalf("required + optional 都应包含：%#v", node.Inputs)
	}
	seed := byName["seed"]
	if seed.Type != "INT" || seed.Link {
		t.Fatalf("seed 应为字面量 INT：%#v", seed)
	}
	// seed 的声明上限是 uint64 最大值，必须原样透传给前端做范围提示。
	if max, ok := workflowNumericBound(seed.Max); !ok || max <= 0 {
		t.Fatalf("seed 上限丢失：%#v", seed.Max)
	}
	sampler := byName["sampler_name"]
	if sampler.Type != "COMBO" || len(sampler.Options) != 2 || sampler.Options[0] != "euler" {
		t.Fatalf("枚举未被识别：%#v", sampler)
	}
	if byName["positive"].Link != true {
		t.Fatalf("CONDITIONING 必须标记为连线输入：%#v", byName["positive"])
	}
	// optional 输入不应被当成必填。
	if denoise := byName["denoise"]; denoise.Required || denoise.Type != "FLOAT" {
		t.Fatalf("optional 输入解析错误：%#v", denoise)
	}
}

func TestComfyUIFetchObjectInfoTrimsToRequestedNodes(t *testing.T) {
	allowLoopbackProviderTest(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/object_info" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(objectInfoFixture))
	}))
	defer server.Close()

	result, err := (&Service{}).FetchComfyUIObjectInfo(context.Background(), ComfyUIObjectInfoRequest{
		BaseURL: server.URL,
		// 上游没有 MissingNode，应跳过而不是整体失败。
		ClassTypes: []string{"CLIPTextEncode", "MissingNode"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["baseUrl"] != server.URL {
		t.Fatalf("baseUrl = %#v", result["baseUrl"])
	}
	nodes, ok := result["nodes"].([]ComfyUIObjectNode)
	if !ok {
		t.Fatalf("nodes 类型 = %T", result["nodes"])
	}
	if len(nodes) != 1 || nodes[0].ClassType != "CLIPTextEncode" {
		t.Fatalf("未按请求裁剪节点：%#v", nodes)
	}
}

func TestComfyUIFetchObjectInfoRejectsUnlistedLoopbackHost(t *testing.T) {
	// 不调用 allowLoopbackProviderTest：本机地址默认应被 SSRF 策略拒绝。
	_, err := (&Service{}).FetchComfyUIObjectInfo(context.Background(), ComfyUIObjectInfoRequest{
		BaseURL:    "http://127.0.0.1:8188",
		ClassTypes: []string{"CLIPTextEncode"},
	})
	if err == nil {
		t.Fatal("未加入白名单的本机地址必须被拒绝")
	}
}

func TestComfyUIFetchObjectInfoRequiresClassTypes(t *testing.T) {
	if _, err := (&Service{}).FetchComfyUIObjectInfo(context.Background(), ComfyUIObjectInfoRequest{
		BaseURL: "http://127.0.0.1:8188",
	}); err == nil {
		t.Fatal("缺少 classTypes 时应返回错误，避免整包回传 969 个节点")
	}
}
