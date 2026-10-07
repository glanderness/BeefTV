package protocol

import (
	"context"
	"encoding/json"
	"testing"
)

// RightAPI 画图接口强制异步：提交固定 async:true 并立即返回 task_id，
// 结果要轮询站点级 /v1/tasks/{task_id}（不带 /draw 前缀）。
// 这里锁定 create 请求形状、轮询路径与三类响应解析，防止 manifest 漂移后静默改变线协议。
func TestRightAPIImageCreateSubmitsAsyncTask(t *testing.T) {
	adapter := officialPackageAdapter(t, "rightapi-image.beeftv-plugin", "rightapi-image")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "lyra-2.6", Prompt: "水彩风格的山谷", AspectRatio: "16:9", Quality: "high", ImageCount: 2,
		Images: []MediaReference{
			{DataURL: "data:image/png;base64,aGVsbG8=", Role: "edit_source"},
			{URL: "https://example.com/mask.png", Role: "mask"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/draw/v1/images/generations" {
		t.Fatalf("create = %s %s", create.Method, create.Path)
	}

	body := manifestTestBody(t, create)
	if body["async"] != true {
		t.Fatalf("async = %#v，上游要求固定 true 才会返回任务 ID", body["async"])
	}
	if body["model"] != "lyra-2.6" || body["prompt"] != "水彩风格的山谷" {
		t.Fatalf("model/prompt = %#v", body)
	}
	if body["n"] != float64(2) {
		t.Fatalf("n = %#v，应来自 imageCount", body["n"])
	}
	if body["size"] != "16:9" {
		t.Fatalf("size = %#v，比例值必须原样透传", body["size"])
	}
	if body["imageSize"] != "4K" {
		t.Fatalf("imageSize = %#v，画布质量档 high 应映射为 4K", body["imageSize"])
	}
	// 参考图必须是 data URL 数组；RightAPI 没有蒙版参数，蒙版图不允许混入。
	images, _ := body["image"].([]any)
	if len(images) != 1 || images[0] != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("image = %#v", body["image"])
	}
}

func TestRightAPIImageOmitsAutoSizeAndDefaultsCount(t *testing.T) {
	adapter := officialPackageAdapter(t, "rightapi-image.beeftv-plugin", "rightapi-image")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "lyra-2.6", Prompt: "无尺寸参数", AspectRatio: "auto",
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, create)
	if _, exists := body["size"]; exists {
		t.Fatalf("size = %#v，auto 时应整体省略交给上游默认", body["size"])
	}
	if _, exists := body["imageSize"]; exists {
		t.Fatalf("imageSize = %#v，质量为 auto 时不应发送", body["imageSize"])
	}
	if body["n"] != float64(1) {
		t.Fatalf("n = %#v，未指定数量时默认 1", body["n"])
	}
}

func TestRightAPIImagePollPathIsSiteLevel(t *testing.T) {
	adapter := officialPackageAdapter(t, "rightapi-image.beeftv-plugin", "rightapi-image")
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "task-abc123"})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Method != "GET" || poll.Path != "/v1/tasks/task-abc123" {
		t.Fatalf("poll = %s %s，任务查询是站点级接口不带 /draw 前缀", poll.Method, poll.Path)
	}
}

func TestRightAPIImageParsesTaskLifecycle(t *testing.T) {
	adapter := officialPackageAdapter(t, "rightapi-image.beeftv-plugin", "rightapi-image")

	// 提交响应只带任务标识，必须进入轮询而不是被误判成成功。
	created, err := adapter.ParseCreate(context.Background(), mustRightJSON(t, map[string]any{
		"task_id": "task-abc123", "status": "processing", "progress": 0,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if created.TaskID != "task-abc123" || created.Status != StatusProcessing {
		t.Fatalf("created = %#v", created)
	}
	if created.Result != nil {
		t.Fatalf("提交响应不应携带结果： %#v", created.Result)
	}

	// 完成响应回译为 OpenAI Images 形状，data[].url 是短期地址。
	polled, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-abc123"}, mustRightJSON(t, map[string]any{
		"task_id": "task-abc123", "status": "completed", "progress": 100,
		"data":    []any{map[string]any{"url": "https://cdn.example.com/tmp/a.png"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if polled.Status != StatusSucceeded || polled.Result == nil || len(polled.Result.Images) != 1 {
		t.Fatalf("polled = %#v", polled)
	}
	image := polled.Result.Images[0]
	if image.URL != "https://cdn.example.com/tmp/a.png" || !image.Ephemeral {
		t.Fatalf("image = %#v，临时地址必须标记 ephemeral 由宿主立即下载", image)
	}

	// 失败响应保留 error.message 的真实语义。
	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-abc123"}, mustRightJSON(t, map[string]any{
		"task_id": "task-abc123", "status": "failed",
		"error":   map[string]any{"code": 40017, "message": "imageSize exceeds model limit"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != StatusFailed || failed.Message != "imageSize exceeds model limit" {
		t.Fatalf("failed = %#v", failed)
	}
}

func mustRightJSON(t *testing.T, value map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
