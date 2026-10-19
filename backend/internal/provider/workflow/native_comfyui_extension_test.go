package workflow

import (
	"context"
	"strings"
	"testing"
)

func TestNativeComfyCandidateDoesNotRegisterBuiltinChannel(t *testing.T) {
	for _, mode := range []string{"image", "video", "audio"} {
		protocol := "comfyui-" + mode
		if IsProviderInterface(protocol) {
			t.Fatalf("candidate became a built-in workflow channel: %s", protocol)
		}
		if err := ValidateConfig(mode, Config{InterfaceType: protocol}); err == nil {
			t.Fatalf("existing channel admission accepted unregistered candidate: %s", protocol)
		}
	}
}

func TestNativeComfyQueryRequiresWorkspaceAndOriginalPrompt(t *testing.T) {
	config := nativeComfyTestConfig("http://127.0.0.1:8188", "image", map[string]any{
		"save": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{}},
	}, nil, "images")
	requests := 0
	client := &Client{Requests: &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		requests++
		return nil, "", nil
	}}}
	for _, input := range []Input{
		{Mode: "image", Config: config},
		{Mode: "image", Config: config, LocalWorkspace: true},
	} {
		promptID := "original"
		if input.LocalWorkspace {
			promptID = ""
		}
		if _, _, err := client.QueryNativeComfy(context.Background(), input, promptID); err == nil {
			t.Fatal("query proceeded without workspace authorization or original prompt")
		}
	}
	if requests != 0 {
		t.Fatalf("invalid query reached transport %d times", requests)
	}
}

func TestNativeComfyModernCancellationTargetsOnlyOriginalPrompt(t *testing.T) {
	requests := 0
	client := &Client{Requests: &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		requests++
		if !strings.HasSuffix(req.URL, "/api/jobs/original-prompt/cancel") || req.Method != "POST" || !req.NoRedirect {
			t.Fatalf("unexpected cancellation request: %s %s redirect=%v", req.Method, req.URL, !req.NoRedirect)
		}
		return []byte(`{"cancelled":true}`), "application/json", nil
	}}}
	if err := client.CancelNativeComfy(context.Background(), Config{BaseURL: "http://127.0.0.1:8188"}, "original-prompt"); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("cancel made %d requests", requests)
	}
}
