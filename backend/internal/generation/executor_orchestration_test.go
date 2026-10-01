package generation

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type stubWorkflowPort struct{ calls atomic.Int32 }

func (s *stubWorkflowPort) Execute(ctx context.Context, input Input) (map[string]interface{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.calls.Add(1)
	return map[string]interface{}{"mode": input.Mode, "workflow": true}, nil
}

type countingPrompt struct{ compiles atomic.Int32 }

func (p *countingPrompt) Compile(string, string, map[string]string) (string, error) {
	p.compiles.Add(1)
	return "compiled-prompt", nil
}

func (p *countingPrompt) ValidateResult(string, map[string]any) error { return nil }

func chatCompletionJSON() string {
	return `{"choices":[{"message":{"content":"ok"}}]}`
}

func TestExecuteTextImageAudioAndWorkflow(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch {
		case strings.Contains(r.URL.Path, "/chat/completions"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, chatCompletionJSON())
		case strings.Contains(r.URL.Path, "/images/generations"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"b64_json":"YQ=="}]}`)
		case strings.Contains(r.URL.Path, "/audio/speech"):
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write([]byte("ID3\x04fake-mp3-body"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	cfg := Config{BaseURL: server.URL, APIKey: "key", Model: "test-model"}

	text, err := Execute(WithRuntime(context.Background(), taskRuntime()), Input{
		Mode: "text", Prompt: "hello", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "test-model", InterfaceType: "chat-completion"},
	})
	if err != nil || text["text"] != "ok" {
		t.Fatalf("text Execute: %#v %v", text, err)
	}

	image, err := Execute(WithRuntime(context.Background(), taskRuntime()), Input{
		Mode: "image", Prompt: "draw", Config: cfg,
	})
	if err != nil {
		t.Fatalf("image Execute: %v", err)
	}
	images, _ := image["images"].([]map[string]string)
	if len(images) != 1 {
		t.Fatalf("image Execute payload = %#v", image)
	}

	workflowPort := &stubWorkflowPort{}
	workflow, err := Execute(WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Workflow = workflowPort
	})), Input{
		Mode: "image", Prompt: "draw",
		Config: Config{
			BaseURL: "https://www.runninghub.cn", APIKey: "key", Model: "wf",
			InterfaceType: string(model.ChannelInterfaceRunningHubImage), WorkflowID: "wf-1",
		},
	})
	if err != nil || workflow["workflow"] != true || workflowPort.calls.Load() != 1 {
		t.Fatalf("workflow Execute: %#v err=%v calls=%d", workflow, err, workflowPort.calls.Load())
	}

	agent, err := Execute(WithRuntime(context.Background(), taskRuntime()), Input{
		Mode: "text", Prompt: "tool", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "test-model", InterfaceType: "chat-completion"},
		AgentRequests: &AgentToolRequests{ChatCompletion: map[string]interface{}{
			"messages": []interface{}{map[string]interface{}{"role": "user", "content": "hi"}},
		}},
	})
	if err != nil || agent["text"] != "ok" {
		t.Fatalf("agent Execute: %#v %v", agent, err)
	}
}

func TestExecuteVideoSkipsPromptTemplateAndHonorsCancel(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(server.Close)
	prompt := &countingPrompt{}
	ctx, cancel := context.WithCancel(WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Prompt = prompt
	})))
	cancel()
	_, err := Execute(ctx, Input{
		Mode: "video", Prompt: "walk",
		Config: Config{BaseURL: server.URL, APIKey: "key", Model: "video-model"},
		Metadata: map[string]interface{}{
			"promptTemplateOperation": "storyboard",
			"promptTemplateVariables": map[string]interface{}{"scene": "1"},
		},
	})
	if prompt.compiles.Load() != 0 {
		t.Fatalf("video compiled prompt template %d times", prompt.compiles.Load())
	}
	if err == nil || hits.Load() != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled video Execute error = %v hits=%d", err, hits.Load())
	}
}

func TestExecuteAudioHonorsCancel(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(WithRuntime(context.Background(), taskRuntime()))
	cancel()
	_, err := Execute(ctx, Input{
		Mode: "audio", Prompt: "speak",
		Config: Config{BaseURL: server.URL, APIKey: "key", Model: "tts"},
	})
	if err == nil || hits.Load() != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled audio Execute error = %v hits=%d", err, hits.Load())
	}
}
