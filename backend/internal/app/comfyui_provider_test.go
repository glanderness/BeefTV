package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

func TestComfyUIRootURLFallsBackToLoopbackAndTrimsSlashes(t *testing.T) {
	cases := map[string]string{
		"":                       defaultComfyUIRootURL,
		"   ":                    defaultComfyUIRootURL,
		"http://127.0.0.1:8188/": "http://127.0.0.1:8188",
		"http://box:8188///":     "http://box:8188",
		" http://box:9000 ":      "http://box:9000",
	}
	for input, want := range cases {
		if got := comfyUIRootURL(input); got != want {
			t.Fatalf("comfyUIRootURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestComfyUIViewURLEncodesFilenameAndSubfolder(t *testing.T) {
	raw := comfyUIViewURL("http://127.0.0.1:8188", map[string]interface{}{
		"filename":  "图 像 1.png",
		"subfolder": "a b/x",
		"type":      "output",
	})
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/view" {
		t.Fatalf("view path = %q, want /view", parsed.Path)
	}
	query := parsed.Query()
	if query.Get("filename") != "图 像 1.png" {
		t.Fatalf("filename = %q", query.Get("filename"))
	}
	// subfolder 含空格与斜杠，必须整体作为查询参数值编码。
	if query.Get("subfolder") != "a b/x" {
		t.Fatalf("subfolder = %q", query.Get("subfolder"))
	}
	if query.Get("type") != "output" {
		t.Fatalf("type = %q", query.Get("type"))
	}
	if strings.Contains(raw, "a b/x") {
		t.Fatalf("subfolder 未被编码：%q", raw)
	}
}

func TestComfyUIViewURLDefaultsOutputType(t *testing.T) {
	raw := comfyUIViewURL("http://127.0.0.1:8188", map[string]interface{}{"filename": "x.png"})
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Query().Get("type"); got != "output" {
		t.Fatalf("type = %q, want output", got)
	}
	if got := parsed.Query().Get("subfolder"); got != "" {
		t.Fatalf("subfolder = %q, want empty", got)
	}
	if raw := comfyUIViewURL("http://127.0.0.1:8188", map[string]interface{}{"filename": "  "}); raw != "" {
		t.Fatalf("空 filename 应返回空地址，得到 %q", raw)
	}
}

func TestComfyUIOutputURLsCollectsImagesGifsAndVideos(t *testing.T) {
	urls := comfyUIOutputURLs("http://127.0.0.1:8188", map[string]interface{}{
		"12": map[string]interface{}{
			"videos": []interface{}{
				map[string]interface{}{"filename": "clip.mp4", "subfolder": "", "type": "output"},
			},
		},
		"9": map[string]interface{}{
			"images": []interface{}{
				map[string]interface{}{"filename": "a.png", "subfolder": "sub", "type": "output"},
				map[string]interface{}{"filename": "b.webp"},
			},
			"gifs": []interface{}{
				map[string]interface{}{"filename": "anim.gif", "type": "temp"},
			},
		},
	})
	if len(urls) != 4 {
		t.Fatalf("产物数量 = %d, want 4：%#v", len(urls), urls)
	}
	// 按节点 ID 排序，保证同一份工作流每次得到稳定顺序。
	if !strings.Contains(urls[0], "a.png") || !strings.Contains(urls[1], "b.webp") {
		t.Fatalf("节点 9 的图片应排在最前：%#v", urls)
	}
	if !strings.Contains(urls[2], "anim.gif") {
		t.Fatalf("gifs 应被收集：%#v", urls)
	}
	if !strings.Contains(urls[3], "clip.mp4") {
		t.Fatalf("videos 应被收集：%#v", urls)
	}
	if !strings.Contains(urls[0], "subfolder=sub") {
		t.Fatalf("subfolder 应保留：%q", urls[0])
	}
}

func TestComfyUIPromptBodyCoercesDeclaredInputTypes(t *testing.T) {
	config := providerConfig{
		InterfaceType: "comfyui-workflow-image",
		WorkflowJSON: map[string]interface{}{
			"3": map[string]interface{}{
				"class_type": "KSampler",
				"inputs": map[string]interface{}{
					"seed":    float64(0),
					"steps":   float64(20),
					"cfg":     float64(8),
					"enabled": false,
				},
			},
			"6": map[string]interface{}{
				"class_type": "CLIPTextEncode",
				"inputs": map[string]interface{}{
					"text": "workflow default",
					"clip": []interface{}{"4", float64(1)},
				},
			},
		},
		WorkflowFields: []WorkflowField{
			{NodeID: "3", FieldName: "seed", FieldType: "INT", FieldValue: "12345"},
			{NodeID: "3", FieldName: "cfg", FieldType: "FLOAT", FieldValue: "7.5"},
			{NodeID: "3", FieldName: "enabled", FieldType: "BOOLEAN", FieldValue: "true"},
			// 已连接的输入属于工作流拓扑，即使被映射也不能覆盖。
			{NodeID: "6", FieldName: "clip", FieldType: "CLIP", Source: "prompt"},
			{NodeID: "6", FieldName: "text", FieldType: "STRING", Source: "prompt"},
		},
	}
	input := canvasGenerationInput{Mode: "image", Prompt: "一只猫"}

	body, err := buildComfyUIPromptBody(config, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	sampler := body["3"].(map[string]interface{})["inputs"].(map[string]interface{})
	if got, ok := sampler["seed"].(int64); !ok || got != 12345 {
		t.Fatalf("seed = %#v (%T), want int64(12345)", sampler["seed"], sampler["seed"])
	}
	if got, ok := sampler["cfg"].(float64); !ok || got != 7.5 {
		t.Fatalf("cfg = %#v (%T), want float64(7.5)", sampler["cfg"], sampler["cfg"])
	}
	if got, ok := sampler["enabled"].(bool); !ok || !got {
		t.Fatalf("enabled = %#v (%T), want true", sampler["enabled"], sampler["enabled"])
	}
	textEncoder := body["6"].(map[string]interface{})["inputs"].(map[string]interface{})
	if got, ok := textEncoder["text"].(string); !ok || got != "一只猫" {
		t.Fatalf("text = %#v (%T), want 一只猫", textEncoder["text"], textEncoder["text"])
	}
	// 关键防御：连线输入必须保持原样，不能被字段映射拆成字面量。
	link, ok := textEncoder["clip"].([]interface{})
	if !ok || len(link) != 2 || link[0] != "4" {
		t.Fatalf("clip = %#v, 连线输入不应被覆盖", textEncoder["clip"])
	}
}

func TestComfyUIPromptBodyDoesNotMutateConfigWorkflow(t *testing.T) {
	original := map[string]interface{}{
		"6": map[string]interface{}{
			"class_type": "CLIPTextEncode",
			"inputs":     map[string]interface{}{"text": "before"},
		},
	}
	config := providerConfig{
		InterfaceType:  "comfyui-workflow-image",
		WorkflowJSON:   original,
		WorkflowFields: []WorkflowField{{NodeID: "6", FieldName: "text", FieldType: "STRING", Source: "prompt"}},
	}
	if _, err := buildComfyUIPromptBody(config, canvasGenerationInput{Mode: "image", Prompt: "after"}, nil); err != nil {
		t.Fatal(err)
	}
	// 任务重试会复用同一份 Config，原地修改会把上次的字段值累积进来。
	if got := original["6"].(map[string]interface{})["inputs"].(map[string]interface{})["text"]; got != "before" {
		t.Fatalf("原始工作流被就地修改：text = %#v", got)
	}
}

func TestComfyUIPromptBodyRequiresWorkflowJSON(t *testing.T) {
	if _, err := buildComfyUIPromptBody(providerConfig{}, canvasGenerationInput{Mode: "image"}, nil); err == nil {
		t.Fatal("缺少工作流 JSON 时应返回错误")
	}
}

func TestComfyUITaskErrorExtractsNodeErrors(t *testing.T) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(`{
		"error": {"message": "Prompt outputs failed validation", "details": "validation"},
		"node_errors": {"6": {"class_type": "CLIPTextEncode", "errors": [{"message": "clip input is required"}]}}
	}`), &payload); err != nil {
		t.Fatal(err)
	}
	message := comfyUITaskError(payload)
	if !strings.Contains(message, "节点 6") || !strings.Contains(message, "CLIPTextEncode") || !strings.Contains(message, "clip input is required") {
		t.Fatalf("节点错误未被提取：%q", message)
	}
	if !strings.Contains(message, "Prompt outputs failed validation") {
		t.Fatalf("顶层错误未被保留：%q", message)
	}
	if message := comfyUITaskError(map[string]any{}); message != "" {
		t.Fatalf("空 payload 应返回空消息，得到 %q", message)
	}
}

func TestComfyUIHTTPFailureMessageParsesValidationBody(t *testing.T) {
	err := providerHTTPError{
		StatusCode: http.StatusBadRequest,
		Body:       `{"node_errors":{"9":{"class_type":"EmptyLatentImage","errors":[{"message":"width must be a multiple of 8"}]}}}`,
	}
	message := comfyUIHTTPFailureMessage(err)
	if !strings.Contains(message, "width must be a multiple of 8") {
		t.Fatalf("HTTP 400 的节点错误未被解析：%q", message)
	}
	if message := comfyUIHTTPFailureMessage(providerHTTPError{StatusCode: http.StatusBadRequest, Body: "plain text"}); message != "" {
		t.Fatalf("非 JSON 响应体不应产生消息，得到 %q", message)
	}
}

func TestComfyUIHistoryEntryTreatsEmptyPayloadAsPending(t *testing.T) {
	if _, found, err := comfyUIHistoryEntry("pid-1", map[string]any{}); err != nil || found {
		t.Fatalf("空对象应视为等待中：found=%v err=%v", found, err)
	}
	payload := map[string]any{"pid-1": map[string]interface{}{"outputs": map[string]interface{}{}}}
	entry, found, err := comfyUIHistoryEntry("pid-1", payload)
	if err != nil || !found || entry == nil {
		t.Fatalf("命中 prompt_id 时应返回条目：found=%v err=%v", found, err)
	}
	// 多于一个条目且都不匹配时无法判断归属，宁可继续等待也不能取错结果。
	multi := map[string]any{
		"other-a": map[string]interface{}{"outputs": map[string]interface{}{}},
		"other-b": map[string]interface{}{"outputs": map[string]interface{}{}},
	}
	if _, found, _ := comfyUIHistoryEntry("pid-1", multi); found {
		t.Fatal("多条目且无匹配时不应返回结果")
	}
	single := map[string]any{"rewritten-key": map[string]interface{}{"outputs": map[string]interface{}{}}}
	if _, found, _ := comfyUIHistoryEntry("pid-1", single); !found {
		t.Fatal("唯一 key 应作为代理改写场景的兜底")
	}
}

func TestComfyUIHistoryFailureOnlyOnErrorStatus(t *testing.T) {
	running := map[string]interface{}{"status": map[string]interface{}{"status_str": "success", "completed": false}}
	if message := comfyUIHistoryFailure(running); message != "" {
		t.Fatalf("非 error 状态不应视为失败：%q", message)
	}
	failed := map[string]interface{}{
		"status": map[string]interface{}{
			"status_str": "error",
			"completed":  true,
			"messages": []interface{}{
				[]interface{}{"execution_error", map[string]interface{}{"node_id": "6", "exception_message": "CUDA out of memory"}},
			},
		},
	}
	message := comfyUIHistoryFailure(failed)
	if !strings.Contains(message, "节点 6") || !strings.Contains(message, "CUDA out of memory") {
		t.Fatalf("执行错误未被提取：%q", message)
	}
}

func TestComfyUIRandomSeedUsesSafeIntegerRange(t *testing.T) {
	// ComfyUI 把 seed 声明到 uint64 上限 18446744073709551615，直接交给
	// strconv.ParseInt 会失败，随机 seed 必须收敛到 JavaScript 安全整数上限。
	config := providerConfig{InterfaceType: "comfyui-workflow-image"}
	field := WorkflowField{
		NodeID: "3", FieldName: "seed", FieldType: "INT",
		Min: 0, Max: float64(18446744073709551615),
		RandomEnabled: true,
	}
	value, present, err := resolveWorkflowFieldValue(field, map[string]string{}, canvasGenerationInput{Mode: "image", Config: config})
	if err != nil {
		t.Fatalf("随机 seed 解析失败：%v", err)
	}
	if !present {
		t.Fatal("随机 seed 应产生值")
	}
	numeric, ok := workflowNumericBound(value)
	if !ok || numeric < 0 || numeric > float64(comfyUISeedRandomMax) {
		t.Fatalf("随机 seed 超出安全整数范围：%#v", value)
	}
}

func TestComfyUIPollTreatsEmptyHistoryAsPendingThenDownloads(t *testing.T) {
	allowLoopbackProviderTest(t)
	pollCalls := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/history/pid-1":
			pollCalls++
			w.Header().Set("Content-Type", "application/json")
			if pollCalls == 1 {
				// ComfyUI 在执行完成前不写入 history，返回空对象。
				_, _ = w.Write([]byte(`{}`))
				return
			}
			_, _ = w.Write([]byte(`{"pid-1":{"outputs":{"9":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}},"status":{"status_str":"success","completed":true}}}`))
		case "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("png-bytes"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	result, err := (&Service{}).pollComfyUIWorkflowWithPolicy(context.Background(), server.URL, "pid-1", fastVideoPollPolicy())
	if err != nil {
		t.Fatal(err)
	}
	// 空对象必须当作等待，而不是 not-found 导致提前失败。
	if pollCalls != 2 {
		t.Fatalf("轮询次数 = %d, want 2（空对象应继续等待）", pollCalls)
	}
	if result["mode"] != "image" {
		t.Fatalf("mode = %#v, want image", result["mode"])
	}
	images, ok := result["images"].([]map[string]interface{})
	if !ok || len(images) != 1 {
		t.Fatalf("images = %#v", result["images"])
	}
}

func TestComfyUIWorkflowSubmitsPromptAndReportsFailure(t *testing.T) {
	allowLoopbackProviderTest(t)
	var submitted map[string]any
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/prompt" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&submitted)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"Prompt outputs failed validation"},"node_errors":{"6":{"class_type":"CLIPTextEncode","errors":[{"message":"clip input is required"}]}}}`))
	}))
	defer server.Close()

	config := providerConfig{
		InterfaceType: "comfyui-workflow-image",
		BaseURL:       server.URL,
		WorkflowJSON: map[string]interface{}{
			"6": map[string]interface{}{"class_type": "CLIPTextEncode", "inputs": map[string]interface{}{"text": "x"}},
		},
	}
	_, err := (&Service{}).runComfyUIWorkflow(context.Background(), canvasGenerationInput{
		Mode: "image", Prompt: "一只猫", Config: config,
	})
	if err == nil {
		t.Fatal("校验失败应返回错误")
	}
	// 错误必须带上节点信息，否则用户无法定位是哪个节点配置有问题。
	if !strings.Contains(err.Error(), "节点 6") || !strings.Contains(err.Error(), "clip input is required") {
		t.Fatalf("错误缺少节点信息：%v", err)
	}
	prompt, ok := submitted["prompt"].(map[string]interface{})
	if !ok || len(prompt) == 0 {
		t.Fatalf("提交体缺少 prompt 对象：%#v", submitted)
	}
	if clientID, _ := submitted["client_id"].(string); clientID == "" {
		t.Fatalf("提交体缺少 client_id：%#v", submitted)
	}
}

func TestComfyUIWorkflowRejectsUnsupportedMediaInputs(t *testing.T) {
	config := providerConfig{
		InterfaceType: "comfyui-workflow-image",
		WorkflowJSON:  map[string]interface{}{"6": map[string]interface{}{"class_type": "CLIPTextEncode", "inputs": map[string]interface{}{"text": "x"}}},
	}
	// 视频、音频参考与蒙版需要 ComfyUI 侧对应的加载节点，本阶段必须显式拒绝，
	// 不能让素材被静默丢弃。
	cases := map[string]canvasGenerationInput{
		"参考视频": {Mode: "image", Config: config, ReferenceVideos: []providerMedia{{ID: "v1", DataURL: "data:video/mp4;base64,AAAA"}}},
		"参考音频": {Mode: "image", Config: config, ReferenceAudios: []providerMedia{{ID: "a1", DataURL: "data:audio/mp3;base64,AAAA"}}},
		"蒙版":   {Mode: "image", Config: config, Mask: &providerMedia{ID: "m1", DataURL: "data:image/png;base64,AAAA"}},
	}
	for name, input := range cases {
		if _, err := (&Service{}).runComfyUIWorkflow(context.Background(), input); err == nil || !strings.Contains(err.Error(), "暂不支持") {
			t.Fatalf("%s 必须显式拒绝：%v", name, err)
		}
	}
}

func TestIsComfyUIInterfaceMatchesDeclaredTypesOnly(t *testing.T) {
	for _, value := range []string{"comfyui-workflow-image", "COMFYUI-WORKFLOW-VIDEO", " comfyui-workflow-image "} {
		if !isComfyUIInterface(value) {
			t.Fatalf("%q 应识别为 ComfyUI 接口", value)
		}
	}
	for _, value := range []string{"", "runninghub-workflow-image", "comfyui-workflow-audio", "openai-image"} {
		if isComfyUIInterface(value) {
			t.Fatalf("%q 不应识别为 ComfyUI 接口", value)
		}
	}
	// 音频尚未支持，不能被声明为 ComfyUI 工作流接口。
	if isWorkflowProviderInterface("comfyui-workflow-audio") {
		t.Fatal("comfyui-workflow-audio 不应被识别为工作流 provider")
	}
}

func TestComfyUIWorkflowUploadsReferenceImageAndInjectsFilename(t *testing.T) {
	allowLoopbackProviderTest(t)
	var uploadedFilename string
	var uploadedType string
	var submitted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload/image":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Errorf("解析 multipart 失败：%v", err)
				http.Error(w, "bad multipart", http.StatusBadRequest)
				return
			}
			file, header, err := r.FormFile("image")
			if err != nil {
				t.Errorf("缺少 image 字段：%v", err)
				http.Error(w, "missing image", http.StatusBadRequest)
				return
			}
			defer file.Close()
			uploadedFilename = header.Filename
			uploadedType = r.FormValue("type")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"name":"` + uploadedFilename + `","subfolder":"","type":"input"}`))
		case "/prompt":
			_ = json.NewDecoder(r.Body).Decode(&submitted)
			_, _ = w.Write([]byte(`{"prompt_id":"pid-ref","number":1,"node_errors":{}}`))
		case "/history/pid-ref":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"pid-ref":{"outputs":{"9":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}},"status":{"status_str":"success","completed":true}}}`))
		case "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("png"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	config := providerConfig{
		InterfaceType: "comfyui-workflow-image",
		BaseURL:       server.URL,
		WorkflowJSON: map[string]interface{}{
			"10": map[string]interface{}{"class_type": "LoadImage", "inputs": map[string]interface{}{"image": "workflow-default.png"}},
			"6":  map[string]interface{}{"class_type": "CLIPTextEncode", "inputs": map[string]interface{}{"text": "x"}},
		},
		WorkflowFields: []WorkflowField{
			{NodeID: "10", FieldName: "image", FieldType: "COMBO", Source: "referenceImage", ImageOrder: 1, Required: true},
			{NodeID: "6", FieldName: "text", FieldType: "STRING", Source: "prompt"},
		},
	}
	result, err := (&Service{}).runComfyUIWorkflow(context.Background(), canvasGenerationInput{
		Mode: "image", Prompt: "一只猫", Config: config,
		ReferenceImages: []providerMedia{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA", Type: "image/png"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("产物分类错误：%#v", result)
	}
	if uploadedFilename == "" {
		t.Fatal("参考图未上传到 /upload/image")
	}
	if uploadedType != "input" {
		t.Fatalf("上传素材应落到 input 目录，得到 %q", uploadedType)
	}
	prompt, ok := submitted["prompt"].(map[string]interface{})
	if !ok {
		t.Fatalf("提交体缺少 prompt：%#v", submitted)
	}
	// 工作流里必须写入上传后的文件名，而不是工作流原有的默认值。
	loadImage, ok := prompt["10"].(map[string]interface{})["inputs"].(map[string]interface{})
	if !ok {
		t.Fatalf("LoadImage 节点结构异常：%#v", prompt["10"])
	}
	if got := loadImage["image"]; got != uploadedFilename {
		t.Fatalf("LoadImage.image = %#v, want %q", got, uploadedFilename)
	}
	textEncode, ok := prompt["6"].(map[string]interface{})["inputs"].(map[string]interface{})
	if !ok {
		t.Fatalf("CLIPTextEncode 节点结构异常：%#v", prompt["6"])
	}
	if got := textEncode["text"]; got != "一只猫" {
		t.Fatalf("提示词未注入：%#v", got)
	}
}

func TestSupportsProviderCancellationIncludesComfyUI(t *testing.T) {
	for _, value := range []string{"comfyui-workflow-image", "comfyui-workflow-video"} {
		if !supportsProviderCancellation(value) {
			t.Fatalf("%s 应支持取消", value)
		}
	}
	// 音频接口尚未接入工作流 provider，不应声明取消能力。
	if supportsProviderCancellation("comfyui-workflow-audio") {
		t.Fatal("未接入的接口不应声明取消能力")
	}
}

func TestComfyUICancelSendsPreciseDeleteAndInterrupt(t *testing.T) {
	allowLoopbackProviderTest(t)
	var mu sync.Mutex
	var deleteBody map[string]any
	var interruptBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/queue":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			deleteBody = body
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodPost && r.URL.Path == "/interrupt":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			interruptBody = body
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	config := providerConfig{InterfaceType: "comfyui-workflow-image", BaseURL: server.URL}
	if err := cancelComfyUITask(context.Background(), config, "pid-1"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if deleteBody == nil {
		t.Fatal("未发送 /queue 删除请求")
	}
	ids, _ := deleteBody["delete"].([]any)
	if len(ids) != 1 || ids[0] != "pid-1" {
		t.Fatalf("delete body = %#v", deleteBody)
	}
	// 关键：不带 prompt_id 的 /interrupt 会全局中断，误伤共享实例上他人的任务。
	if interruptBody == nil || interruptBody["prompt_id"] != "pid-1" {
		t.Fatalf("interrupt 必须带 prompt_id：%#v", interruptBody)
	}
}

func TestComfyUICancellationReconciliation(t *testing.T) {
	allowLoopbackProviderTest(t)
	var mu sync.Mutex
	queue := "{}"
	history := "{}"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/queue":
			_, _ = w.Write([]byte(queue))
		case strings.HasPrefix(r.URL.Path, "/history/"):
			_, _ = w.Write([]byte(history))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	config := providerConfig{InterfaceType: "comfyui-workflow-image", BaseURL: server.URL}
	cases := []struct {
		name       string
		queue      string
		history    string
		want       providerCancellationOutcome
		wantStatus string
	}{
		{"仍在排队", `{"queue_pending":[[1,"pid-1",{}]]}`, `{}`, providerCancellationPending, "queued"},
		{"正在执行", `{"queue_running":[[1,"pid-1",{}]]}`, `{}`, providerCancellationPending, "running"},
		// 被从队列删除的任务不会写入 history，这是判断取消成功的关键依据。
		{"已从队列移除", `{}`, `{}`, providerCancellationConfirmed, "removed"},
		// 真实环境实测：被 /interrupt 中断的任务是 completed=false，不是 true。
		// 若把 completed=false 一律当作"仍在执行"，取消状态会永远停在待确认。
		{"被中断", `{}`, `{"pid-1":{"status":{"status_str":"error","completed":false,"messages":[["execution_start",{"prompt_id":"pid-1"}],["execution_interrupted",{"prompt_id":"pid-1","node_id":"3","node_type":"KSampler"}]]}}}`, providerCancellationConfirmed, "interrupted"},
		{"执行中未完成", `{}`, `{"pid-1":{"status":{"status_str":"success","completed":false,"messages":[]}}}`, providerCancellationPending, "executing"},
		{"取消前已成功", `{}`, `{"pid-1":{"status":{"status_str":"success","completed":true}}}`, providerCancellationSucceeded, "success"},
		{"执行失败而非取消", `{}`, `{"pid-1":{"status":{"status_str":"error","completed":true,"messages":[["execution_error",{"exception_message":"boom"}]]}}}`, providerCancellationFailed, "error"},
	}
	for _, tc := range cases {
		mu.Lock()
		queue = tc.queue
		history = tc.history
		mu.Unlock()
		outcome, status, err := queryComfyUICancellation(context.Background(), config, "pid-1")
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if outcome != tc.want || status != tc.wantStatus {
			t.Fatalf("%s: got (%s, %s), want (%s, %s)", tc.name, outcome, status, tc.want, tc.wantStatus)
		}
	}
}

func TestComfyUIQueuedPromptIDsParsesQueueEntries(t *testing.T) {
	// 队列条目形状为 [序号, prompt_id, workflow, extra]。
	running, pending := comfyUIQueuedPromptIDs(map[string]any{
		"queue_running": []interface{}{[]interface{}{float64(1), "pid-run", map[string]any{}}},
		"queue_pending": []interface{}{
			[]interface{}{float64(2), "pid-wait", map[string]any{}},
			[]interface{}{float64(3), "", map[string]any{}},
		},
	})
	if len(running) != 1 || running[0] != "pid-run" {
		t.Fatalf("running = %#v", running)
	}
	// 空 prompt_id 的条目必须被跳过。
	if len(pending) != 1 || pending[0] != "pid-wait" {
		t.Fatalf("pending = %#v", pending)
	}
}

func TestComfyUIWorkflowRejectsReferenceImageWithoutSlotMapping(t *testing.T) {
	// 工作流没有配置参考图槽位时必须报错，不能把参考图静默丢弃。
	config := providerConfig{
		InterfaceType: "comfyui-workflow-image",
		WorkflowJSON:  map[string]interface{}{"6": map[string]interface{}{"class_type": "CLIPTextEncode", "inputs": map[string]interface{}{"text": "x"}}},
		WorkflowFields: []WorkflowField{
			{NodeID: "6", FieldName: "text", FieldType: "STRING", Source: "prompt"},
		},
	}
	_, err := (&Service{}).runComfyUIWorkflow(context.Background(), canvasGenerationInput{
		Mode: "image", Prompt: "一只猫", Config: config,
		ReferenceImages: []providerMedia{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA"}},
	})
	if err == nil || !strings.Contains(err.Error(), "槽位") {
		t.Fatalf("缺少参考图槽位映射时必须报错：%v", err)
	}
}
