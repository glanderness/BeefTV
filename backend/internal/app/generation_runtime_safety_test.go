package app

import (
	"context"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestBindGenerationRuntimeReplacesFullProviderMetadata(t *testing.T) {
	svc := &Service{}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: "http://127.0.0.1:9"})
	ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{
		UserID: "user-1", TaskID: "task-1", TraceID: "trace-old", RequestID: "req-old",
		Capability: "video", Operation: "generate", ChannelID: "channel-old", Model: "model-old",
		VideoSeconds: 5, ProviderRequestID: "orig",
	})
	ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{
		UserID: "user-1", TaskID: "task-1", TraceID: "trace-new", RequestID: "req-new",
		Capability: "video", Operation: "generate", ChannelID: "channel-new", Model: "model-new",
		VideoSeconds: 10, ProviderRequestID: "orig",
	})
	meta, ok := generation.CallMetaFromContext(ctx)
	if !ok {
		t.Fatal("runtime missing after rebind")
	}
	if meta.Model != "model-new" || meta.TraceID != "trace-new" || meta.ChannelID != "channel-new" || meta.RequestID != "req-new" || meta.VideoSeconds != 10 {
		t.Fatalf("second route did not replace Call: %#v", meta)
	}
	if meta.ProviderRequestID != "orig" {
		t.Fatalf("original provider ID lost: %#v", meta)
	}
	runtime, _ := generation.RuntimeFromContext(ctx)
	if runtime.Images == nil || runtime.Receipts == nil || runtime.Probe == nil {
		t.Fatalf("required ports missing after rebind: %#v", runtime)
	}
	if runtime.Endpoints.BeefAPIVideoBaseURL != "http://127.0.0.1:9" {
		t.Fatalf("endpoint override lost after rebind: %#v", runtime.Endpoints)
	}
}

func TestEnrichGenerationRuntimeKeepsCurrentRoute(t *testing.T) {
	svc := &Service{}
	ctx := svc.bindGenerationRuntime(context.Background(), generation.CallMeta{
		UserID: "user-1", TaskID: "task-1", TraceID: "trace-1", Capability: "video",
		ChannelID: "channel-1", Model: "model-1", VideoSeconds: 8, ProviderRequestID: "orig",
	})
	ctx = svc.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: "user-1", TaskID: "task-1", RequestKind: "poll"})
	meta, _ := generation.CallMetaFromContext(ctx)
	if meta.RequestKind != "poll" {
		t.Fatalf("RequestKind = %q, want poll", meta.RequestKind)
	}
	if meta.Model != "model-1" || meta.TraceID != "trace-1" || meta.ChannelID != "channel-1" || meta.VideoSeconds != 8 || meta.ProviderRequestID != "orig" {
		t.Fatalf("enrich wiped route: %#v", meta)
	}
}

func TestCanonicalCallMetaUsesGenerationRequestKind(t *testing.T) {
	ctx := withProviderAnalytics(context.Background(), nil, model.Task{
		ID: "task-1", UserID: "user-1", Type: "canvas_video", TraceID: "trace-1",
		InputJSON: `{"mode":"video","config":{"model":"seedance-2.5","channelId":"channel-1","videoSeconds":"8"}}`,
	})
	call := canonicalCallMeta(generation.WithRequestKind(ctx, "poll"))
	if call.RequestKind != "poll" {
		t.Fatalf("RequestKind = %q, want poll", call.RequestKind)
	}
	if call.TaskID != "task-1" || call.UserID != "user-1" || call.Model != "seedance-2.5" || call.ChannelID != "channel-1" || call.TraceID != "trace-1" {
		t.Fatalf("canonical Call lost route: %#v", call)
	}
}
