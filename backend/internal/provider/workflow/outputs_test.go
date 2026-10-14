package workflow

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestWorkflowRetainsMixedOutputsAndOriginOnResume(t *testing.T) {
	creates := 0
	client := productionClient(&scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/outputs") {
			return []byte(`{"code":0,"data":[{"fileurl":"https://cdn.example/preview.png","nodeId":"8"},{"DownloadURL":"https://cdn.example/a.mp4","nodeId":"9"},{"fileUrl":"https://cdn.example/b.mp4","nodeId":"9"},{" FILE_URL ":"https://cdn.example/a.wav"},{"download_url":"https://cdn.example/b.wav"},{"fileUrl":"https://cdn.example/meta.json"}]}`), "application/json", nil
		}
		if req.Kind == "create" {
			creates++
		}
		mimeType := "application/octet-stream"
		if strings.HasSuffix(req.URL, ".json") {
			mimeType = "application/json"
		}
		return []byte("artifact"), mimeType, nil
	}})
	result, err := client.RunRunningHub(context.Background(), Input{Mode: "video", ResumedRequestID: "original-task", Config: Config{InterfaceType: "runninghub-workflow-video", BaseURL: "https://www.runninghub.cn", APIKey: "test"}})
	if err != nil {
		t.Fatal(err)
	}
	outputs := result["outputs"].([]map[string]interface{})
	want := []string{"image", "video", "video", "audio", "audio", "file"}
	if len(outputs) != len(want) || creates != 0 {
		t.Fatalf("outputs=%d creates=%d", len(outputs), creates)
	}
	for index, kind := range want {
		if outputs[index]["mediaType"] != kind || outputs[index]["outputIndex"] != index {
			t.Fatalf("output %d: %#v", index, outputs[index])
		}
	}
	if outputs[1]["sourceNodeId"] != "9" {
		t.Fatal("lost output origin")
	}
	if _, ok := result["video"]; ok {
		t.Fatal("duplicated video bytes outside canonical outputs")
	}
}

func TestOutputCollectorAcceptsNormalizedGatewayKeys(t *testing.T) {
	for _, key := range []string{"fileUrl", "fileurl", " FILEURL ", "file_url", "File_URL", "DownloadURL", " download_url ", "URL", " Src "} {
		t.Run(key, func(t *testing.T) {
			outputs := runningHubOutputs(map[string]any{" DaTa ": map[string]any{"OuTpUtS": []any{map[string]any{key: "https://cdn.example/result.mp4", "nodeId": "9"}}}})
			if len(outputs) != 1 || outputs[0].URL != "https://cdn.example/result.mp4" || outputs[0].NodeID != "9" {
				t.Fatalf("outputs=%#v", outputs)
			}
		})
	}
}

func TestOutputCollectorKeepsDeterministicAliasAndArrayOrder(t *testing.T) {
	value := map[string]any{
		"fileurl":      "https://cdn.example/lower.mp4",
		" fileUrl ":    "https://cdn.example/spaced.mp4",
		"fileUrl":      "https://cdn.example/canonical.mp4",
		"DownloadURL":  "https://cdn.example/download.mp4",
		"unrecognized": "https://cdn.example/ignore.mp4",
		"OUTPUTS": []any{
			map[string]any{"FILE_URL": "https://cdn.example/first.png", "nodeId": "8"},
			map[string]any{"fileurl": "https://cdn.example/second.wav", "nodeId": "9"},
			map[string]any{"url": "https://cdn.example/canonical.mp4"},
		},
	}
	want := []workflowOutput{
		{URL: "https://cdn.example/canonical.mp4"},
		{URL: "https://cdn.example/spaced.mp4"},
		{URL: "https://cdn.example/lower.mp4"},
		{URL: "https://cdn.example/download.mp4"},
		{URL: "https://cdn.example/first.png", NodeID: "8"},
		{URL: "https://cdn.example/second.wav", NodeID: "9"},
	}
	for i := 0; i < 100; i++ {
		if got := runningHubOutputs(value); !reflect.DeepEqual(got, want) {
			t.Fatalf("iteration %d: outputs=%#v", i, got)
		}
	}
}

func TestOutputCollectorPreservesProviderOrderAndDistinctOrigins(t *testing.T) {
	outputs := runningHubOutputs([]any{map[string]any{"fileUrl": "https://cdn.example/a.mp4", "nodeId": "9"}, map[string]any{"fileUrl": "https://cdn.example/a.mp4", "nodeId": "10"}, map[string]any{"fileUrl": "https://cdn.example/a.mp4", "nodeId": "9"}})
	if len(outputs) != 2 || outputs[0].NodeID != "9" || outputs[1].NodeID != "10" {
		t.Fatalf("outputs=%#v", outputs)
	}
}
