package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/outbound"
)

func comfyUIInput() Input {
	var prompt map[string]any
	_ = json.Unmarshal([]byte(`{
		"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"base.safetensors"}},
		"2":{"class_type":"CLIPTextEncode","inputs":{"text":"negative words","clip":["1",1]},"_meta":{"title":"Negative"}},
		"3":{"class_type":"CLIPTextEncode","inputs":{"text":"original positive","clip":["1",1]},"_meta":{"title":"Positive"}},
		"4":{"class_type":"KSampler","inputs":{"positive":["3",0],"negative":["2",0],"seed":7,"steps":20}},
		"5":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512,"batch_size":1}},
		"6":{"class_type":"SaveImage","inputs":{"images":["4",0],"filename_prefix":"BeefTV"}}
	}`), &prompt)
	return Input{Mode: "image", Prompt: "new positive", Config: Config{InterfaceType: "comfyui-image", BaseURL: "https://8.8.8.8/proxy", WorkflowJSON: prompt}}
}

func comfyUIHistory(id, group, filename string) []byte {
	data, _ := json.Marshal(map[string]any{id: map[string]any{
		"status":  map[string]any{"completed": true, "status_str": "success"},
		"outputs": map[string]any{"6": map[string]any{group: []any{map[string]any{"filename": filename, "subfolder": "BeefTV", "type": "output"}}}},
	}})
	return data
}

func TestComfyUIInspectReadsInstalledModelsWithoutGenerating(t *testing.T) {
	input := comfyUIInput()
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.URL != input.Config.BaseURL+"/object_info" || req.Method != http.MethodGet || !req.CustomRelay {
			t.Fatalf("unexpected schema request: %+v", req)
		}
		info := map[string]any{}
		for _, raw := range input.Config.WorkflowJSON {
			info[raw.(map[string]any)["class_type"].(string)] = map[string]any{}
		}
		info["CheckpointLoaderSimple"] = map[string]any{"input": map[string]any{"required": map[string]any{"ckpt_name": []any{[]any{"base.safetensors", "other.safetensors"}}}}}
		info["KSampler"] = map[string]any{"input": map[string]any{"required": map[string]any{"steps": []any{"INT", map[string]any{"min": 1, "max": 100, "step": 1}}}}}
		data, _ := json.Marshal(info)
		return data, "application/json", nil
	}}
	result, err := productionClient(exec).InspectComfyUI(context.Background(), input.Config, "image")
	if err != nil {
		t.Fatal(err)
	}
	fields := result["fields"].([]map[string]any)
	prompts := 0
	for _, field := range fields {
		if field["source"] == "prompt" {
			prompts++
			if field["nodeId"] != "3" {
				t.Fatalf("negative prompt was bound: %+v", field)
			}
		}
		if field["fieldName"] == "ckpt_name" && !reflect.DeepEqual(field["options"], []any{"base.safetensors", "other.safetensors"}) {
			t.Fatalf("checkpoint options: %+v", field)
		}
		if field["fieldName"] == "steps" && (field["fieldType"] != "INT" || field["max"] != float64(100)) {
			t.Fatalf("numeric schema: %+v", field)
		}
	}
	if prompts != 1 || len(exec.paths()) != 1 {
		t.Fatalf("prompts=%d requests=%v", prompts, exec.paths())
	}
}

func TestComfyUIPromptPreservesTopologyNegativePromptAndJSONTypes(t *testing.T) {
	input := comfyUIInput()
	before, _ := json.Marshal(input.Config.WorkflowJSON)
	input.Config.Size = "768x1024"
	fields := []Field{
		{NodeID: "3", FieldName: "text", Source: "prompt"},
		{NodeID: "5", FieldName: "width", Source: "width", FieldType: "INT"},
		{NodeID: "5", FieldName: "height", FieldValue: "640", FieldType: "INT"},
	}
	prompt, err := buildComfyUIPrompt(input, fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	inputs := prompt["5"].(map[string]any)["inputs"].(map[string]any)
	if inputs["width"] != int64(768) || inputs["height"] != int64(640) {
		t.Fatalf("JSON numeric fields: %+v", inputs)
	}
	if prompt["2"].(map[string]any)["inputs"].(map[string]any)["text"] != "negative words" {
		t.Fatal("negative text was changed")
	}
	if prompt["3"].(map[string]any)["inputs"].(map[string]any)["text"] != input.Prompt {
		t.Fatal("positive text was not bound")
	}
	if !reflect.DeepEqual(prompt["4"], input.Config.WorkflowJSON["4"]) {
		t.Fatal("topology changed")
	}
	after, _ := json.Marshal(input.Config.WorkflowJSON)
	if !bytes.Equal(before, after) {
		t.Fatal("saved workflow mutated")
	}
	_, err = buildComfyUIPrompt(input, []Field{{NodeID: "4", FieldName: "positive", Source: "prompt"}}, nil)
	if err == nil {
		t.Fatal("connected input override was accepted")
	}
}

func TestComfyUIRunUploadsReferencesRecordsReceiptAndDownloads(t *testing.T) {
	input := comfyUIInput()
	input.LocalWorkspace = true
	input.Config.APIKey = "synthetic-key"
	input.Config.Headers = []outbound.OutboundHeader{{Name: "X-Project", Value: "synthetic-project"}}
	input.Config.WorkflowJSON["8"] = map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "original.png"}}
	input.Config.WorkflowFields = []Field{{NodeID: "3", FieldName: "text", Source: "prompt"}, {NodeID: "8", FieldName: "image", Source: "referenceImage", Required: true}}
	input.ReferenceImages = []Media{{ID: "ref-1", DataURL: "data:image/png;base64,UE5HREFUQQ=="}}
	receipt := &memoryReceipt{}
	var order []string
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if !req.CustomRelay {
			t.Fatal("native request bypassed custom relay policy")
		}
		headers := http.Header{}
		for _, header := range req.Headers {
			headers.Set(header.Name, header.Value)
		}
		if headers.Get("Authorization") != "Bearer synthetic-key" || headers.Get("X-Project") != "synthetic-project" {
			t.Fatal("provider auth missing")
		}
		u, _ := url.Parse(req.URL)
		order = append(order, req.Kind)
		switch u.Path {
		case "/proxy/upload/image":
			_, params, _ := mime.ParseMediaType(req.ContentType)
			reader := multipart.NewReader(bytes.NewReader(req.Body), params["boundary"])
			fields := map[string]string{}
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				data, _ := io.ReadAll(part)
				fields[part.FormName()] = string(data)
			}
			if fields["image"] != "PNGDATA" || fields["subfolder"] != "beeftv" || fields["type"] != "input" {
				t.Fatalf("multipart: %+v", fields)
			}
			return []byte(`{"name":"ref.png","subfolder":"beeftv"}`), "application/json", nil
		case "/proxy/prompt":
			var body map[string]map[string]any
			if err := json.Unmarshal(req.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body["prompt"]["8"].(map[string]any)["inputs"].(map[string]any)["image"] != "beeftv/ref.png" {
				t.Fatalf("uploaded input not bound: %s", req.Body)
			}
			return []byte(`{"prompt_id":"accepted-1"}`), "application/json", nil
		case "/proxy/history/accepted-1":
			if !reflect.DeepEqual(receipt.acceptedIDs(), []string{"accepted-1"}) {
				t.Fatal("polled before durable acceptance")
			}
			return comfyUIHistory("accepted-1", "images", "result.png"), "application/json", nil
		case "/proxy/view":
			if u.Query().Get("filename") != "result.png" || u.Query().Get("subfolder") != "BeefTV" {
				t.Fatalf("view URL: %s", req.URL)
			}
			return []byte("PNGDATA"), "image/png", nil
		}
		t.Fatalf("unexpected request %s", req.URL)
		return nil, "", nil
	}}
	result, err := productionClient(exec, receipt).Run(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(order, []string{"upload", "create", "poll", "download"}) {
		t.Fatalf("calls: %v", order)
	}
	if len(result["images"].([]any)) != 1 {
		t.Fatalf("result: %+v", result)
	}
}

func TestComfyUIResumeOnlyQueriesOriginalTaskForEveryCapability(t *testing.T) {
	for _, tc := range []struct{ mode, group, filename, mime, expectedMIME string }{
		{"image", "images", "out.png", "image/png", "image/png"},
		{"video", "gifs", "out.mp4", "video/mp4", "video/mp4"},
		{"audio", "audio", "out.flac", "audio/flac", "audio/flac"},
		{"audio", "audio", "out.ogg", "application/ogg", "audio/ogg"},
	} {
		t.Run(tc.mode+"/"+tc.filename, func(t *testing.T) {
			input := comfyUIInput()
			input.Mode = tc.mode
			input.Config.InterfaceType = "comfyui-" + tc.mode
			input.ResumedRequestID = "original"
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if strings.Contains(req.URL, "/history/original") {
					return comfyUIHistory("original", tc.group, tc.filename), "application/json", nil
				}
				if strings.Contains(req.URL, "/view?") {
					return []byte("MEDIA"), tc.mime, nil
				}
				t.Fatalf("resume attempted %s", req.URL)
				return nil, "", nil
			}}
			client := productionClient(exec)
			client.Receipt = nil
			result, err := client.Run(context.Background(), input)
			if err != nil || result["mode"] != tc.mode || len(exec.paths()) != 2 {
				t.Fatalf("result=%v err=%v requests=%v", result, err, exec.paths())
			}
			media := result[tc.mode]
			if tc.mode == "image" {
				media = result["images"].([]any)[0]
			}
			if media.(map[string]any)["mimeType"] != tc.expectedMIME {
				t.Fatalf("media MIME type: %v", media)
			}
		})
	}
}

func TestComfyUIReceiptFailuresDoNotSubmitOrPollAgain(t *testing.T) {
	for _, ready := range []bool{true, false} {
		receipt := &memoryReceipt{}
		if ready {
			receipt.failReady = errors.New("receipt unavailable")
		} else {
			receipt.failAccepted = errors.New("receipt write failed")
		}
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if ready || !strings.HasSuffix(req.URL, "/prompt") {
				t.Fatalf("unexpected request after receipt failure: %+v", req)
			}
			return []byte(`{"prompt_id":"accepted"}`), "application/json", nil
		}}
		_, err := productionClient(exec, receipt).Run(context.Background(), comfyUIInput())
		if err == nil {
			t.Fatal("receipt failure swallowed")
		}
		var accepted AcceptedNotRecorded
		if !ready && (!errors.As(err, &accepted) || accepted.RequestID != "accepted" || len(exec.paths()) != 1) {
			t.Fatalf("acceptance fence: err=%v calls=%v", err, exec.paths())
		}
	}
}

func TestComfyUIRandomSeedAcceptsDecodedUInt64SchemaBounds(t *testing.T) {
	input := comfyUIInput()
	fields := []Field{{NodeID: "4", FieldName: "seed", RandomEnabled: true, Min: float64(0), Max: float64(18446744073709551615)}}
	for i := 0; i < 3; i++ {
		prompt, err := buildComfyUIPrompt(input, fields, nil)
		if err != nil {
			t.Fatal(err)
		}
		seed, ok := prompt["4"].(map[string]any)["inputs"].(map[string]any)["seed"].(int64)
		if !ok || seed < 0 || seed > 9007199254740991 {
			t.Fatalf("unsafe seed=%v", seed)
		}
	}
}

func TestComfyUIHistoryFailureAndMissingOutputsAreErrors(t *testing.T) {
	for _, history := range []string{`{"original":{"status":{"completed":false,"status_str":"error"}}}`, `{"original":{"status":{"completed":true,"status_str":"success"},"outputs":{}}}`} {
		exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) { return []byte(history), "application/json", nil }}
		_, stage, err := productionClient(exec).queryComfyUI(context.Background(), comfyUIInput().Config, "original", "image")
		if err == nil || stage != "failed" {
			t.Fatalf("stage=%s err=%v", stage, err)
		}
	}
}

func TestComfyUIRejectsHTMLMediaAndDoesNotDownloadVideoPreviews(t *testing.T) {
	for _, contentType := range []string{"text/html", "application/json"} {
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if req.Kind == "poll" {
				return comfyUIHistory("original", "images", "out.png"), "application/json", nil
			}
			return []byte("login required"), contentType, nil
		}}
		if _, _, err := productionClient(exec).queryComfyUI(context.Background(), comfyUIInput().Config, "original", "image"); err == nil {
			t.Fatal("non-media response accepted")
		}
	}
	downloads := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Kind == "poll" {
			return []byte(`{"original":{"status":{"completed":true},"outputs":{"6":{"images":[{"filename":"preview.png"}],"gifs":[{"filename":"out.mp4"},{"filename":"unused.mp4"}]}}}}`), "application/json", nil
		}
		if !strings.Contains(req.URL, "filename=out.mp4") {
			t.Fatalf("unneeded download: %s", req.URL)
		}
		downloads++
		return []byte("VIDEO"), "video/mp4", nil
	}}
	result, _, err := productionClient(exec).queryComfyUI(context.Background(), comfyUIInput().Config, "original", "video")
	if err != nil || result["video"] == nil || downloads != 1 {
		t.Fatalf("result=%v err=%v downloads=%d", result, err, downloads)
	}
}

func TestComfyUIDistinguishesRejectedAndUncertainCreates(t *testing.T) {
	for _, tc := range []struct {
		failure   error
		uncertain bool
	}{
		{StatusError{StatusCode: 400, Err: errors.New("invalid prompt")}, false},
		{io.ErrUnexpectedEOF, true},
	} {
		exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) { return nil, "", tc.failure }}
		_, err := productionClient(exec).Run(context.Background(), comfyUIInput())
		var uncertain CreateUncertain
		if err == nil || errors.As(err, &uncertain) != tc.uncertain {
			t.Fatalf("error=%v uncertain=%v", err, tc.uncertain)
		}
	}
}

func TestComfyUIRequiresAPIJSONAndRespectsOutboundPolicy(t *testing.T) {
	for _, raw := range []string{`{}`, `{"nodes":[],"links":[]}`, `{"1":{"class_type":"SaveImage","inputs":{"images":["missing",0]}}}`, `{"1":{"class_type":"SaveImage","inputs":{"images":["1",-1]}}}`} {
		var prompt map[string]any
		_ = json.Unmarshal([]byte(raw), &prompt)
		if ValidateComfyUIWorkflow(prompt) == nil {
			t.Fatalf("invalid API JSON accepted: %s", raw)
		}
	}
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "")
	for _, address := range []string{"http://127.0.0.1:8188", "http://localhost:8188", "http://192.168.1.8:8188"} {
		if _, err := ComfyUIRootURL(address); err != nil {
			t.Fatalf("local upstream rejected by default: %v", err)
		}
	}
	if _, err := ComfyUIRootURL("http://169.254.169.254:8188"); err == nil {
		t.Fatal("link-local host accepted")
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	if _, err := ComfyUIRootURL("http://127.0.0.1:8188"); err == nil {
		t.Fatal("private host accepted in strict mode without an allowlist")
	}
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	input := comfyUIInput()
	input.Config.BaseURL = "http://127.0.0.1:8188"
	if err := ValidateConfig("image", input.Config); err != nil {
		t.Fatalf("keyless local config: %v", err)
	}
	for _, address := range []string{"http://localhost:8188", "http://127.0.0.1:8188?token=synthetic", "http://user:synthetic@127.0.0.1:8188"} {
		if _, err := ComfyUIRootURL(address); err == nil {
			t.Fatalf("unsafe address accepted: %s", address)
		}
	}
}
