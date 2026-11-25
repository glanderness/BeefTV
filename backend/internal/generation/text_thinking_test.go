package generation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestApplyTextThinkingQwenAndDashScope(t *testing.T) {
	t.Run("qwen hybrid models disable thinking explicitly when thinking is false", func(t *testing.T) {
		for _, model := range []string{"qwen3.6-plus", "qwen3.5-plus", "qwen3.8-max", "qwen3-max", "qwen-plus", "alibaba/qwen3-32b"} {
			body := map[string]interface{}{}
			ApplyTextThinking(body, Input{
				Config:      Config{BaseURL: "https://relay.example.com/v1", Model: model},
				TextOptions: TextOptions{Thinking: false},
			}, "chat-completion")
			if body["enable_thinking"] != false {
				t.Fatalf("model %s: enable_thinking = %#v, want false", model, body["enable_thinking"])
			}
			if _, hasEffort := body["reasoning_effort"]; hasEffort {
				t.Fatalf("model %s: unexpected reasoning_effort when thinking is false: %#v", model, body)
			}
		}
	})

	t.Run("qwen hybrid models enable thinking explicitly without reasoning_effort when thinking is true", func(t *testing.T) {
		for _, cfg := range []Config{
			{BaseURL: "https://relay.example.com/v1", Model: "qwen3.6-plus"},
			{BaseURL: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1", Model: "qwen3.7-plus"},
		} {
			body := map[string]interface{}{}
			ApplyTextThinking(body, Input{
				Config:      cfg,
				TextOptions: TextOptions{Thinking: true},
			}, "chat-completion")
			if body["enable_thinking"] != true {
				t.Fatalf("model %s: enable_thinking = %#v, want true", cfg.Model, body["enable_thinking"])
			}
			if _, hasEffort := body["reasoning_effort"]; hasEffort {
				t.Fatalf("model %s: unexpected reasoning_effort on Qwen thinking control: %#v", cfg.Model, body)
			}
		}
	})

	t.Run("dashscope compatible-mode host sends enable_thinking false for hosted models when thinking is false", func(t *testing.T) {
		for _, baseURL := range []string{
			"https://dashscope.aliyuncs.com/compatible-mode/v1",
			"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			"https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
			"https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
		} {
			body := map[string]interface{}{}
			ApplyTextThinking(body, Input{
				Config:      Config{BaseURL: baseURL, Model: "deepseek-v4.1-flash"},
				TextOptions: TextOptions{Thinking: false},
			}, "chat-completion")
			if body["enable_thinking"] != false {
				t.Fatalf("baseURL %s: enable_thinking = %#v, want false", baseURL, body["enable_thinking"])
			}
		}
	})

	t.Run("non-qwen models on non-dashscope hosts and non-hybrid qwen variants stay unchanged", func(t *testing.T) {
		cases := []struct {
			protocol string
			cfg      Config
		}{
			{"chat-completion", Config{BaseURL: "https://api.openai.com/v1", Model: "gpt-4o"}},
			{"chat-completion", Config{BaseURL: "https://relay.example.com/v1", Model: "deepseek-v4.1-flash"}},
			{"chat-completion", Config{BaseURL: "https://relay.example.com/v1", Model: "qwen2.5-72b-instruct"}},
			{"chat-completion", Config{BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Model: "qwen3-235b-a22b-thinking-2507"}},
			{"responses", Config{BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Model: "qwen3.6-plus"}},
			{"claude-api", Config{BaseURL: "https://dashscope.aliyuncs.com/apps/anthropic", Model: "qwen3.6-plus"}},
		}
		for _, tc := range cases {
			body := map[string]interface{}{}
			ApplyTextThinking(body, Input{Config: tc.cfg, TextOptions: TextOptions{Thinking: false}}, tc.protocol)
			if _, exists := body["enable_thinking"]; exists {
				t.Fatalf("protocol=%s model=%s base=%s unexpectedly set enable_thinking: %#v", tc.protocol, tc.cfg.Model, tc.cfg.BaseURL, body)
			}
		}
	})
}

func TestRunChatCompletionsTextTaskSendsEnableThinkingFalseForQwenNonStreaming(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var captured map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	t.Cleanup(server.Close)

	result, err := RunChatCompletionsTextTask(context.Background(), Input{
		Mode:   "text",
		Prompt: "你好",
		Config: Config{
			BaseURL:       server.URL + "/v1",
			APIKey:        "test-key",
			Model:         "qwen3.6-plus",
			InterfaceType: "chat-completion",
		},
		TextOptions: TextOptions{Thinking: false},
		StreamText:  false,
	})
	if err != nil {
		t.Fatalf("RunChatCompletionsTextTask() error = %v", err)
	}
	if result["text"] != "ok" {
		t.Fatalf("text = %#v, want ok", result["text"])
	}
	if captured["enable_thinking"] != false {
		t.Fatalf("sent enable_thinking = %#v, want false (body=%#v)", captured["enable_thinking"], captured)
	}
}
