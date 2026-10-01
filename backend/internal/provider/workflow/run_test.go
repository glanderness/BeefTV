package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

type scriptedExecutor struct {
	mu      sync.Mutex
	calls   []Request
	handler func(req Request) ([]byte, string, error)
}

func (s *scriptedExecutor) Execute(ctx context.Context, req Request) ([]byte, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	s.calls = append(s.calls, req)
	s.mu.Unlock()
	return s.handler(req)
}

func (s *scriptedExecutor) paths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	paths := make([]string, 0, len(s.calls))
	for _, call := range s.calls {
		paths = append(paths, call.URL)
	}
	return paths
}

type stubMedia struct{}

func (stubMedia) LocalBytes(media Media) ([]byte, string, error) {
	if strings.HasPrefix(media.DataURL, "data:") {
		mimeType, data, err := decodeDataURL(media.DataURL)
		return data, mimeType, err
	}
	return nil, "", errors.New("后端任务队列需要 data URL 形式的本地参考素材")
}

type immediatePoller struct{}

func (immediatePoller) Poll(ctx context.Context, _ string, _ PollPolicy, query func(context.Context) (PollOutcome, error)) (map[string]interface{}, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out, err := query(ctx)
		if err != nil {
			return nil, err
		}
		if out.Done {
			return out.Result, nil
		}
	}
}

func (immediatePoller) Download(ctx context.Context, _ string, _ PollPolicy, download func(context.Context) ([]byte, string, error)) ([]byte, string, error) {
	return download(ctx)
}

type cancelSleep struct{ DefaultTimePolicy }

func (cancelSleep) Sleep(context.Context, time.Duration) error { return context.Canceled }

type denyPlugin struct{ err error }

func (d denyPlugin) EnsureEnabled(context.Context, string) error { return d.err }

func pngJSON() []byte {
	return []byte(`{"code":0,"data":[{"fileUrl":"https://rh-images.xiaoyaoyou.com/out.png"}]}`)
}

func TestRunResumesOriginalAcceptedTaskWithoutCreate(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") || strings.Contains(req.URL, "/ai-app/run") {
			t.Fatal("resume must not create a new upstream task")
		}
		if strings.Contains(req.URL, "/task/openapi/outputs") {
			body, _ := json.Marshal(map[string]any{"apiKey": "k", "taskId": "orig-9"})
			if string(req.Body) != string(body) {
				t.Fatalf("poll body = %s", req.Body)
			}
			return pngJSON(), "application/json", nil
		}
		if strings.HasSuffix(req.URL, "/out.png") {
			return []byte("PNGDATA"), "image/png", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Media: stubMedia{}, Poller: immediatePoller{}}
	result, err := client.RunRunningHub(context.Background(), Input{
		Mode:             "image",
		ResumedRequestID: "orig-9",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
	if len(exec.paths()) == 0 {
		t.Fatal("expected poll/download calls")
	}
}

func TestCreateOmitsCodeButReturnsTaskIDThenPollsOriginal(t *testing.T) {
	creates := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.Contains(req.URL, "/task/openapi/create"):
			creates++
			return []byte(`{"data":{"taskId":"accepted-1"}}`), "application/json", nil
		case strings.Contains(req.URL, "/task/openapi/outputs"):
			var payload map[string]any
			_ = json.Unmarshal(req.Body, &payload)
			if payload["taskId"] != "accepted-1" {
				t.Fatalf("poll taskId = %#v", payload["taskId"])
			}
			return pngJSON(), "application/json", nil
		case strings.HasSuffix(req.URL, "/out.png"):
			return []byte("PNGDATA"), "image/png", nil
		default:
			t.Fatalf("unexpected URL %s", req.URL)
			return nil, "", nil
		}
	}}
	client := &Client{Requests: exec, Media: stubMedia{}, Poller: immediatePoller{}}
	result, err := client.RunRunningHub(context.Background(), Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
			WorkflowJSON:  map[string]interface{}{"1": map[string]interface{}{"class_type": "Note", "inputs": map[string]interface{}{}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creates != 1 {
		t.Fatalf("creates = %d, want 1", creates)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
}

func TestCreateProtocolErrorIsReturned(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") {
			return []byte(`{"code":805,"msg":"NODE_INFO_MISMATCH"}`), "application/json", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Media: stubMedia{}, Poller: immediatePoller{}}
	_, err := client.RunRunningHub(context.Background(), Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
			WorkflowJSON:  map[string]interface{}{"1": map[string]interface{}{"class_type": "Note", "inputs": map[string]interface{}{}}},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "重新选择该 App") {
		t.Fatalf("error = %v, want actionable protocol message", err)
	}
}

func TestPollCancelDoesNotCreateNewTask(t *testing.T) {
	polls := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/create") {
			t.Fatal("cancel path must not create")
		}
		if strings.Contains(req.URL, "/outputs") {
			polls++
			return []byte(`{"code":804,"msg":"running"}`), "application/json", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Time: cancelSleep{}, Poller: immediatePoller{}}
	_, err := client.Poll(context.Background(), Config{APIKey: "k"}, "https://www.runninghub.cn", "orig-7", "image")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if polls != 1 {
		t.Fatalf("polls = %d, want 1", polls)
	}
}

func TestPluginAuthorizationBlocksRun(t *testing.T) {
	denied := errors.New("RunningHub 工作流插件未启用")
	client := &Client{
		Requests: &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
			t.Fatal("disabled plugin must not call upstream")
			return nil, "", nil
		}},
		Plugins: denyPlugin{err: denied},
	}
	_, err := client.Run(context.Background(), Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if !errors.Is(err, denied) {
		t.Fatalf("error = %v, want plugin denial", err)
	}
}

func TestAppModeUsesAiAppEndpoint(t *testing.T) {
	var createURL string
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/ai-app/run") || strings.HasSuffix(req.URL, "/task/openapi/create") {
			createURL = req.URL
			return []byte(`{"code":0,"data":{"taskId":"app-1"}}`), "application/json", nil
		}
		if strings.Contains(req.URL, "/outputs") {
			return pngJSON(), "application/json", nil
		}
		if strings.HasSuffix(req.URL, "/out.png") {
			return []byte("PNGDATA"), "image/png", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Media: stubMedia{}, Poller: immediatePoller{}}
	_, err := client.RunRunningHub(context.Background(), Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WebappID:      "app-88",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(createURL, "/task/openapi/ai-app/run") {
		t.Fatalf("app endpoint = %s", createURL)
	}
}

func TestLocalWorkspaceRejectsMediaUpload(t *testing.T) {
	client := &Client{Requests: &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("local workspace must not upload")
		return nil, "", nil
	}}}
	_, err := client.RunRunningHub(context.Background(), Input{
		Mode:           "video",
		LocalWorkspace: true,
		ReferenceImages: []Media{{
			ID:      "ref-1",
			DataURL: "data:image/png;base64,AAAA",
		}},
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubVideo),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("error = %v", err)
	}
}

func TestUploadAuthFailureUsesStatusBody(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Kind == "upload" && req.Method == http.MethodPost {
			return nil, "", StatusError{StatusCode: http.StatusUnauthorized, Body: `ApiKey verification failed`, Err: errors.New("401")}
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Media: stubMedia{}}
	_, err := client.UploadMedia(context.Background(), "https://www.runninghub.cn", Config{RunningHubUploadKey: "upload-key"}, Media{
		ID:      "ref-1",
		DataURL: "data:image/png;base64,AAAA",
	}, false)
	if err == nil || !strings.Contains(err.Error(), "素材上传 API Key（企业级）") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateConfigRequiresWorkflowIdentity(t *testing.T) {
	err := ValidateConfig("image", Config{
		InterfaceType: string(model.ChannelInterfaceRunningHubImage),
		BaseURL:       "https://www.runninghub.cn",
		APIKey:        "k",
	})
	if err == nil || !strings.Contains(err.Error(), "workflowId") {
		t.Fatalf("error = %v", err)
	}
}
