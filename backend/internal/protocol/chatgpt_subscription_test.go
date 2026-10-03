package protocol

import (
	"context"
	"testing"
)

func TestChatGPTSubscriptionAdapterPinsStreamingShape(t *testing.T) {
	adapter, ok := Builtins().Get("chatgpt-subscription")
	if !ok {
		t.Fatal("chatgpt-subscription adapter is not registered")
	}
	metadata := adapter.Metadata()
	if len(metadata.Categories) != 1 || metadata.Categories[0] != CapabilityText {
		t.Fatalf("subscription adapter must stay text-only: %#v", metadata.Categories)
	}

	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "gpt-5-codex", Prompt: "写六个镜头"}})
	if err != nil {
		t.Fatalf("build create: %v", err)
	}
	if spec.Method != "POST" || spec.Path != "/responses" {
		t.Fatalf("unexpected request line: %s %s", spec.Method, spec.Path)
	}
	body, ok := spec.Body.(map[string]any)
	if !ok {
		t.Fatalf("create body must be a JSON object, got %T", spec.Body)
	}
	if body["stream"] != true {
		t.Fatalf("ChatGPT backend requires streaming, got %#v", body["stream"])
	}
	if body["store"] != false {
		t.Fatalf("store must be pinned to false, got %#v", body["store"])
	}
	include, _ := body["include"].([]any)
	if len(include) != 1 || include[0] != "reasoning.encrypted_content" {
		t.Fatalf("unexpected include list: %#v", body["include"])
	}
	if body["model"] != "gpt-5-codex" {
		t.Fatalf("model must be forwarded verbatim, got %#v", body["model"])
	}
}

func TestChatGPTSubscriptionAdapterCannotDisableStreaming(t *testing.T) {
	adapter, ok := Builtins().Get("chatgpt-subscription")
	if !ok {
		t.Fatal("chatgpt-subscription adapter is not registered")
	}
	// extra 是插件/调用方可控字段，不能用来把强制流式关掉。
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "gpt-5-codex", Prompt: "hi", Extra: map[string]any{"stream": false, "store": true, "instructions": "你是助理。"},
	}})
	if err != nil {
		t.Fatalf("build create: %v", err)
	}
	body, _ := spec.Body.(map[string]any)
	if body["stream"] != true {
		t.Fatalf("stream must stay true even when extra requests otherwise, got %#v", body["stream"])
	}
	if body["instructions"] != "你是助理。" {
		t.Fatalf("instructions must pass through, got %#v", body["instructions"])
	}
}

func TestChatGPTSubscriptionAdapterParsesResponsesOutput(t *testing.T) {
	adapter, ok := Builtins().Get("chatgpt-subscription")
	if !ok {
		t.Fatal("chatgpt-subscription adapter is not registered")
	}
	result, err := adapter.ParseCreate(context.Background(), []byte(`{"output_text":"分镜一：雨夜追逐。","usage":{"input_tokens":10,"output_tokens":4}}`))
	if err != nil {
		t.Fatalf("parse create: %v", err)
	}
	if result.Result.Text != "分镜一：雨夜追逐。" {
		t.Fatalf("unexpected text: %#v", result.Result.Text)
	}
	if result.Status != StatusSucceeded {
		t.Fatalf("unexpected status: %#v", result.Status)
	}
}

func TestChatGPTSubscriptionAdapterHasDetailedDocumentation(t *testing.T) {
	adapter, ok := Builtins().Get("chatgpt-subscription")
	if !ok {
		t.Fatal("chatgpt-subscription adapter is not registered")
	}
	metadata := adapter.Metadata()
	AttachDocumentation(&metadata)
	if metadata.Documentation == "" {
		t.Fatal("subscription protocol must ship a reference document")
	}
}
