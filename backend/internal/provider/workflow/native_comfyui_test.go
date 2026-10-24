package workflow

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/outbound"
)

var testPNG = []byte{
	0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0x0d, 'I', 'H', 'D', 'R',
	0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
}

func testWAV() []byte {
	data := make([]byte, 44+16)
	copy(data[0:], "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 8000)
	binary.LittleEndian.PutUint32(data[28:], 8000)
	binary.LittleEndian.PutUint16(data[32:], 1)
	binary.LittleEndian.PutUint16(data[34:], 8)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], 16)
	return data
}

func testMP4() []byte {
	return []byte{
		0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0, 'i', 's', 'o', 'm',
		0, 0, 0, 8, 'f', 'r', 'e', 'e',
	}
}

type nativeComfyHTTPExecutor struct{ client *http.Client }

func (e nativeComfyHTTPExecutor) Execute(ctx context.Context, req Request) ([]byte, string, error) {
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return nil, "", err
	}
	if req.ContentType != "" {
		httpReq.Header.Set("Content-Type", req.ContentType)
	}
	outbound.ApplyOutboundHeaders(httpReq, req.Headers)
	response, err := e.client.Do(httpReq)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, "", err
	}
	mimeType := response.Header.Get("Content-Type")
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", StatusError{StatusCode: response.StatusCode, Body: string(data), Err: fmt.Errorf("HTTP %d", response.StatusCode)}
	}
	return data, mimeType, nil
}

func nativeComfyTestConfig(baseURL string, mode string, graph map[string]any, fields []Field, outputField string) Config {
	return Config{
		InterfaceType: "comfyui-" + mode, BaseURL: baseURL, AuthType: "none",
		ComfyUI: &ComfyWorkflow{Graph: graph, Fields: fields, OutputNodeID: "save", OutputField: outputField},
	}
}

func TestNativeComfyUploadPromptReceiptHistoryAndView(t *testing.T) {
	cases := []struct {
		mode        string
		outputField string
		filename    string
		content     []byte
		contentType string
	}{
		{"image", "images", "out.png", testPNG, "image/png"},
		{"video", "images", "out.mp4", testMP4(), "video/mp4"},
		{"audio", "audio", "out.wav", testWAV(), "audio/wav"},
		{"audio", "audio", "out.opus", append([]byte("OggS\x00"), bytes.Repeat([]byte{0}, 64)...), "audio/ogg"},
	}
	for _, testCase := range cases {
		t.Run(testCase.mode, func(t *testing.T) {
			receipt := &memoryReceipt{}
			var uploads, prompts int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/object_info":
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(nativeComfyObjectInfo())
				case "/upload/image":
					atomic.AddInt64(&uploads, 1)
					if err := r.ParseMultipartForm(16 << 20); err != nil {
						t.Error(err)
					}
					if r.FormValue("type") != "input" || r.FormValue("overwrite") != "false" || r.FormValue("subfolder") != "beeftv" {
						t.Fatalf("invalid upload fields: %#v", r.MultipartForm)
					}
					file, header, err := r.FormFile("image")
					if err != nil {
						t.Error(err)
					} else {
						data, readErr := io.ReadAll(file)
						file.Close()
						if readErr != nil {
							t.Error(readErr)
						}
						switch header.Header.Get("Content-Type") {
						case "image/png":
							if !bytes.Equal(data, testPNG) {
								t.Errorf("png bytes mismatch: %x", data)
							}
						case "video/mp4":
							if !bytes.Equal(data, testMP4()) {
								t.Errorf("mp4 bytes mismatch: %x", data)
							}
						case "audio/wav":
							if !bytes.Equal(data, testWAV()) {
								t.Errorf("wav bytes mismatch: %x", data)
							}
						}
					}
					extension := ".bin"
					if strings.HasSuffix(header.Filename, ".png") {
						extension = ".png"
					} else if strings.HasSuffix(header.Filename, ".mp4") {
						extension = ".mp4"
					} else if strings.HasSuffix(header.Filename, ".wav") {
						extension = ".wav"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"name": "uploaded" + extension, "subfolder": "beeftv"})
				case "/prompt":
					atomic.AddInt64(&prompts, 1)
					var body struct {
						Prompt   map[string]map[string]any `json:"prompt"`
						ClientID string                    `json:"client_id"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body.ClientID != "local-task-1" {
						t.Errorf("client id = %q", body.ClientID)
					}
					values := body.Prompt["image"]["inputs"].(map[string]any)
					if values["image"] != "beeftv/uploaded.png [input]" {
						t.Errorf("image binding = %#v", values["image"])
					}
					if testCase.mode == "video" {
						if got := body.Prompt["video"]["inputs"].(map[string]any)["file"]; got != "beeftv/uploaded.mp4 [input]" {
							t.Errorf("video binding = %#v", got)
						}
						if got := body.Prompt["audio"]["inputs"].(map[string]any)["audio"]; got != "beeftv/uploaded.wav [input]" {
							t.Errorf("audio binding = %#v", got)
						}
						if got := body.Prompt["prompt"]["inputs"].(map[string]any)["negative"]; got != "blurry" {
							t.Errorf("negative binding = %#v", got)
						}
						if got := body.Prompt["seed"]["inputs"].(map[string]any)["seed"]; got != 7.0 {
							t.Errorf("seed binding = %#v", got)
						}
					}
					_, _ = w.Write([]byte(`{"prompt_id":"comfy-accepted"}`))
				case "/history/comfy-accepted":
					if len(receipt.acceptedIDs()) == 0 {
						t.Fatal("history polled before accepted receipt was persisted")
					}
					animated := []any{}
					if testCase.mode == "video" {
						animated = append(animated, true)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"comfy-accepted": map[string]any{
						"status":  map[string]any{"status_str": "success", "completed": true},
						"outputs": map[string]any{"save": map[string]any{testCase.outputField: []any{map[string]any{"filename": testCase.filename, "subfolder": "outputs", "type": "output"}}, "animated": animated}},
					}})
				case "/view":
					if r.URL.Query().Get("filename") != testCase.filename || r.URL.Query().Get("subfolder") != "outputs" || r.URL.Query().Get("type") != "output" {
						t.Fatalf("invalid view query: %s", r.URL.RawQuery)
					}
					w.Header().Set("Content-Type", testCase.contentType)
					_, _ = w.Write(testCase.content)
				default:
					t.Fatalf("unexpected endpoint %s", r.URL.Path)
				}
			}))
			defer server.Close()

			graph, input := nativeComfyMixedInput(server.URL, testCase.mode)
			if testCase.mode == "audio" {
				input.ReferenceImages[0].ID = ""
				input.ReferenceVideos[0].ID = ""
				input.ReferenceAudios[0].ID = ""
			}
			client := &Client{
				Requests: nativeComfyHTTPExecutor{client: server.Client()}, Media: stubMedia{},
				Receipt: receipt, Poller: immediatePoller{},
			}
			result, err := client.RunNativeComfy(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			if result["mode"] != testCase.mode {
				t.Fatalf("mode = %#v, result = %#v", result["mode"], result)
			}
			_ = graph
			if uploads == 0 || prompts != 1 {
				t.Fatalf("uploads=%d prompts=%d", uploads, prompts)
			}
			nativeComfyAssertResultBytes(t, result, testCase.mode, testCase.content)
		})
	}
}

func nativeComfyMixedInput(baseURL, mode string) (map[string]any, Input) {
	graph := map[string]any{
		"image":  map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "placeholder.png"}},
		"prompt": map[string]any{"class_type": "Prompt", "inputs": map[string]any{"text": "original", "negative": "original"}},
		"seed":   map[string]any{"class_type": "Seed", "inputs": map[string]any{"seed": 1.0}},
	}
	fields := []Field{{NodeID: "image", FieldName: "image", Source: "referenceImage"}}
	input := Input{
		Mode: mode, LocalWorkspace: true, ClientID: "local-task-1",
		Config:          nativeComfyTestConfig(baseURL, mode, graph, fields, "images"),
		ReferenceImages: []Media{{ID: "image-ref", DataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(testPNG)}},
	}
	if mode != "image" {
		graph["video"] = map[string]any{"class_type": "LoadVideo", "inputs": map[string]any{"file": "placeholder.mp4"}}
		graph["audio"] = map[string]any{"class_type": "LoadAudio", "inputs": map[string]any{"audio": "placeholder.wav"}}
		fields = append(fields,
			Field{NodeID: "video", FieldName: "file", Source: "referenceVideo"},
			Field{NodeID: "audio", FieldName: "audio", Source: "referenceAudio"},
			Field{NodeID: "prompt", FieldName: "negative", Source: "negativePrompt"},
			Field{NodeID: "seed", FieldName: "seed", Source: "seed"},
		)
		input.Config.ComfyUI.Fields = fields
		input.Config.ComfyUI.OutputField = map[string]string{"video": "images", "audio": "audio"}[mode]
		input.ReferenceVideos = []Media{{ID: "video-ref", DataURL: "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(testMP4())}}
		input.ReferenceAudios = []Media{{ID: "audio-ref", DataURL: "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(testWAV())}}
		input.Config.NegativePrompt = "blurry"
		input.Config.Seed = "7"
	} else {
		input.Config.ComfyUI.OutputField = "images"
	}
	if mode == "audio" {
		graph["save"] = map[string]any{"class_type": "SaveAudio", "inputs": map[string]any{"audio": []any{"audio", 0}}}
	} else if mode == "video" {
		graph["save"] = map[string]any{"class_type": "SaveVideo", "inputs": map[string]any{"video": []any{"image", 0}}}
	} else {
		graph["save"] = map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"image", 0}}}
	}
	return graph, input
}

func nativeComfyObjectInfo() map[string]any {
	upload := func(flag string) []any {
		return []any{[]any{}, map[string]any{flag: true}}
	}
	return map[string]any{
		"LoadImage": map[string]any{"input": map[string]any{"required": map[string]any{"image": upload("image_upload")}}},
		"LoadVideo": map[string]any{"input": map[string]any{"required": map[string]any{"file": upload("video_upload")}}},
		"LoadAudio": map[string]any{"input": map[string]any{"required": map[string]any{"audio": upload("audio_upload")}}},
		"Prompt":    map[string]any{"input": map[string]any{"required": map[string]any{"text": []any{"STRING", map[string]any{}}, "negative": []any{"STRING", map[string]any{}}}}},
		"Seed":      map[string]any{"input": map[string]any{"required": map[string]any{"seed": []any{"INT", map[string]any{}}}}},
		"SaveImage": map[string]any{"input": map[string]any{"required": map[string]any{"images": []any{"IMAGE", map[string]any{}}}}},
		"SaveVideo": map[string]any{"input": map[string]any{"required": map[string]any{"video": []any{"VIDEO", map[string]any{}}}}},
		"SaveAudio": map[string]any{"input": map[string]any{"required": map[string]any{"audio": []any{"AUDIO", map[string]any{}}}}},
	}
}

func nativeComfyAssertResultBytes(t *testing.T, result map[string]any, mode string, content []byte) {
	t.Helper()
	var value map[string]interface{}
	switch mode {
	case "image":
		items, _ := result["images"].([]map[string]interface{})
		if len(items) != 1 {
			t.Fatalf("images = %#v", result["images"])
		}
		value = items[0]
	case "video":
		value, _ = result["video"].(map[string]interface{})
	case "audio":
		value, _ = result["audio"].(map[string]interface{})
	}
	if value == nil {
		t.Fatalf("missing %s result: %#v", mode, result)
	}
	_, data, err := decodeDataURL(fmt.Sprint(value["dataUrl"]))
	if err != nil || !bytes.Equal(data, content) {
		t.Fatalf("result bytes mismatch: err=%v len=%d", err, len(data))
	}
}

func TestNativeComfyResumeSkipsUploadAndPrompt(t *testing.T) {
	var objectInfo, prompts, uploads, history int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/object_info":
			atomic.AddInt64(&objectInfo, 1)
			_ = json.NewEncoder(w).Encode(nativeComfyObjectInfo())
		case "/upload/image":
			atomic.AddInt64(&uploads, 1)
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "reference.png", "subfolder": "beeftv"})
		case "/prompt":
			atomic.AddInt64(&prompts, 1)
			_, _ = w.Write([]byte(`{"prompt_id":"resume-me"}`))
		case "/history/resume-me":
			atomic.AddInt64(&history, 1)
			_, _ = w.Write([]byte(`{"resume-me":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`))
		case "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(testPNG)
		default:
			t.Fatalf("unexpected endpoint %s", r.URL.Path)
		}
	}))
	defer server.Close()
	_, input := nativeComfyMixedInput(server.URL, "image")
	client := &Client{Requests: nativeComfyHTTPExecutor{client: server.Client()}, Media: stubMedia{}, Receipt: &memoryReceipt{}, Poller: immediatePoller{}}
	if _, err := client.RunNativeComfy(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	input.ResumedRequestID = "resume-me"
	if _, err := client.RunNativeComfy(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if prompts != 1 || uploads != 1 || objectInfo != 1 || history != 2 {
		t.Fatalf("prompts=%d uploads=%d objectInfo=%d history=%d", prompts, uploads, objectInfo, history)
	}
}

func TestNativeComfyCreateFailureClasses(t *testing.T) {
	objectInfo := func() []byte {
		encoded, err := json.Marshal(nativeComfyObjectInfo())
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	newInput := func() Input {
		return Input{
			Mode: "image", LocalWorkspace: true, ClientID: "local-task-1",
			Config: nativeComfyTestConfig("http://127.0.0.1:18188", "image", map[string]any{
				"save": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{}}},
			}, nil, "images"),
		}
	}
	t.Run("definite validation failure", func(t *testing.T) {
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if strings.HasSuffix(req.URL, "/object_info") {
				return objectInfo(), "application/json", nil
			}
			return nil, "", StatusError{StatusCode: http.StatusBadRequest, Body: `{"node_errors":{"1":["bad model"]}}`, Err: errors.New("400")}
		}}
		_, err := productionClient(exec).RunNativeComfy(context.Background(), newInput())
		if err == nil || strings.Contains(err.Error(), "尚未确认") {
			t.Fatalf("definite validation classified as uncertain: %v", err)
		}
	})
	t.Run("transport failure is uncertain", func(t *testing.T) {
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if strings.HasSuffix(req.URL, "/object_info") {
				return objectInfo(), "application/json", nil
			}
			return nil, "", errors.New("connection lost")
		}}
		_, err := productionClient(exec).RunNativeComfy(context.Background(), newInput())
		var uncertain CreateUncertain
		if !errors.As(err, &uncertain) {
			t.Fatalf("transport error not uncertain: %T %v", err, err)
		}
	})
	t.Run("accepted but receipt write fails", func(t *testing.T) {
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if strings.HasSuffix(req.URL, "/object_info") {
				return objectInfo(), "application/json", nil
			}
			if strings.HasSuffix(req.URL, "/history/comfy-id") {
				t.Fatal("polled before receipt write")
			}
			return []byte(`{"prompt_id":"comfy-id"}`), "application/json", nil
		}}
		receipt := &memoryReceipt{failAccepted: errors.New("database unavailable")}
		_, err := productionClient(exec, receipt).RunNativeComfy(context.Background(), newInput())
		var accepted AcceptedNotRecorded
		if !errors.As(err, &accepted) || accepted.RequestID != "comfy-id" {
			t.Fatalf("accepted-not-recorded error = %T %v", err, err)
		}
	})
	t.Run("missing history and queue never resubmits", func(t *testing.T) {
		prompts := 0
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			switch {
			case strings.HasSuffix(req.URL, "/object_info"):
				return objectInfo(), "application/json", nil
			case strings.HasSuffix(req.URL, "/prompt"):
				prompts++
				return []byte(`{"prompt_id":"missing-id"}`), "application/json", nil
			default:
				return []byte(`{}`), "application/json", nil
			}
		}}
		input := newInput()
		input.ResumedRequestID = "missing-id"
		_, err := productionClient(exec).RunNativeComfy(context.Background(), input)
		if err == nil || !strings.Contains(err.Error(), "不会自动重新提交") {
			t.Fatalf("missing history error = %v", err)
		}
		if prompts != 0 {
			t.Fatalf("resume submitted %d prompts", prompts)
		}
	})
}

func TestNativeComfyInvalidOutputsNeverSucceed(t *testing.T) {
	cases := []struct {
		name      string
		filename  string
		subfolder string
		status    int
	}{
		{"missing output", "", "", http.StatusOK},
		{"traversal", "../escape.png", "outputs", http.StatusOK},
		{"download failure", "out.png", "outputs", http.StatusBadGateway},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/object_info":
					_ = json.NewEncoder(w).Encode(nativeComfyObjectInfo())
				case "/upload/image":
					_, _ = w.Write([]byte(`{"name":"uploaded.png","subfolder":"beeftv"}`))
				case "/prompt":
					_, _ = w.Write([]byte(`{"prompt_id":"failed-output"}`))
				case "/history/failed-output":
					item := map[string]any{"filename": testCase.filename, "subfolder": testCase.subfolder, "type": "output"}
					items := []any{}
					if testCase.filename != "" {
						items = append(items, item)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"failed-output": map[string]any{"status": map[string]any{"status_str": "success", "completed": true}, "outputs": map[string]any{"save": map[string]any{"images": items}}}})
				case "/view":
					http.Error(w, "download failed", testCase.status)
				default:
					t.Fatalf("unexpected endpoint %s", r.URL.Path)
				}
			}))
			defer server.Close()
			_, input := nativeComfyMixedInput(server.URL, "image")
			receipt := &memoryReceipt{}
			client := &Client{Requests: nativeComfyHTTPExecutor{client: server.Client()}, Media: stubMedia{}, Receipt: receipt, Poller: immediatePoller{}}
			if _, err := client.RunNativeComfy(context.Background(), input); err == nil {
				t.Fatal("invalid output returned success")
			}
			if ids := receipt.acceptedIDs(); len(ids) != 1 || ids[0] != "failed-output" {
				t.Fatalf("accepted IDs = %#v", ids)
			}
		})
	}
}

func TestNativeComfyConfigAcceptsAllModesWithoutKey(t *testing.T) {
	for _, mode := range []string{"image", "video", "audio"} {
		config := nativeComfyTestConfig("http://127.0.0.1:18188", mode, map[string]any{
			"1":    map[string]any{"class_type": "Source", "inputs": map[string]any{"value": "fixed"}},
			"save": map[string]any{"class_type": "Save", "inputs": map[string]any{"value": []any{"1", 0}}},
		}, nil, "images")
		if err := ValidateNativeComfyConfig(mode, config); err != nil {
			t.Fatalf("mode %s: %v", mode, err)
		}
	}
}

func TestNativeComfyTargetReportsMissingClassAndModel(t *testing.T) {
	nodes := map[string]any{
		"ModelLoader": map[string]any{"input": map[string]any{"required": map[string]any{
			"model": []any{[]any{"correct.safetensors"}, map[string]any{}},
		}}},
	}
	missingClass := map[string]any{"1": map[string]any{"class_type": "MissingNode", "inputs": map[string]any{}}}
	err := validateNativeComfyTarget(missingClass, nil, nodes)
	if err == nil || !strings.Contains(err.Error(), "缺少节点 1（MissingNode）") {
		t.Fatalf("missing class error = %v", err)
	}
	wrongModel := map[string]any{"1": map[string]any{"class_type": "ModelLoader", "inputs": map[string]any{"model": "wrong.safetensors"}}}
	err = validateNativeComfyTarget(wrongModel, nil, nodes)
	if err == nil || !strings.Contains(err.Error(), "model") || !strings.Contains(err.Error(), "wrong.safetensors") {
		t.Fatalf("wrong model error = %v", err)
	}
}

func TestNativeComfyOutputSafetyAndClassificationHelpers(t *testing.T) {
	for _, name := range []string{"", ".", "..", "../out.png", "nested/out.png", `c:\out.png`} {
		if safeNativeComfyFile(name, "outputs") {
			t.Fatalf("accepted unsafe filename %q", name)
		}
	}
	for _, folder := range []string{"/outputs", "../outputs", "outputs/../escape", `outputs\escape`} {
		if safeNativeComfyFile("out.png", folder) {
			t.Fatalf("accepted unsafe subfolder %q", folder)
		}
	}
	if got := nativeComfyMIME("out.mp4", "", testMP4(), true); got != "video/mp4" {
		t.Fatalf("SaveVideo images MP4 MIME = %q", got)
	}
	if got := nativeComfyMIME("out.wav", "", testWAV(), false); got != "audio/wave" {
		t.Fatalf("SaveAudio WAV MIME = %q", got)
	}
	if got := nativeComfyMIME("out.png", "", testPNG, false); got != "image/png" {
		t.Fatalf("SaveImage PNG MIME = %q", got)
	}
}

func TestNativeComfyMaskUsesExplicitRoleAndChannel(t *testing.T) {
	nodes := nativeComfyObjectInfo()
	nodes["LoadImageMask"] = map[string]any{"input": map[string]any{"required": map[string]any{
		"image":   []any{[]any{}, map[string]any{"image_upload": true}},
		"channel": []any{[]any{"alpha", "red", "green", "blue"}, map[string]any{}},
	}}}
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/object_info"):
			return mustNativeJSON(nodes), "application/json", nil
		case strings.HasSuffix(req.URL, "/upload/image"):
			if !strings.Contains(string(req.Body), "form-data") || !strings.Contains(string(req.Body), "name=image") {
				t.Fatalf("mask upload body is not the image multipart field: %d bytes", len(req.Body))
			}
			return []byte(`{"name":"mask.png","subfolder":"beeftv"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/prompt"):
			var body struct {
				Prompt map[string]map[string]any `json:"prompt"`
			}
			if err := json.Unmarshal(req.Body, &body); err != nil {
				t.Fatal(err)
			}
			values := body.Prompt["mask"]["inputs"].(map[string]any)
			if values["image"] != "beeftv/mask.png [input]" || values["channel"] != "alpha" {
				t.Fatalf("mask bindings = %#v", values)
			}
			return []byte(`{"prompt_id":"mask-done"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/history/mask-done"):
			return []byte(`{"mask-done":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`), "application/json", nil
		case strings.Contains(req.URL, "/view?"):
			return testPNG, "image/png", nil
		default:
			t.Fatalf("unexpected request %s", req.URL)
			return nil, "", nil
		}
	}}
	graph := map[string]any{
		"mask": map[string]any{"class_type": "LoadImageMask", "inputs": map[string]any{"image": "placeholder.png", "channel": "alpha"}},
		"save": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"mask", 0}}},
	}
	input := Input{
		Mode: "image", LocalWorkspace: true, ClientID: "local-task-1",
		Config: nativeComfyTestConfig("http://127.0.0.1:18188", "image", graph, []Field{
			{NodeID: "mask", FieldName: "image", Source: "mask"},
		}, "images"),
		Mask: &Media{ID: "mask-ref", DataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(testPNG)},
	}
	if _, err := productionClient(exec).RunNativeComfy(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}

func mustNativeJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
