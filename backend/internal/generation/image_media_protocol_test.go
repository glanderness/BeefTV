package generation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestManagedImageMissingOrUnknownProtocolNeverUploadsOrGenerates(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, version := range []string{"", "direct-media-v99"} {
		t.Run(version, func(t *testing.T) {
			gets, posts := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
					posts++
					t.Error("request left metadata preflight")
					return
				}
				gets++
				if r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get(ImageMediaProtocolHeader) != "" || r.Header.Get("Idempotency-Key") != "" {
					t.Error("invalid metadata probe")
				}
				w.Header().Set(ImageMediaProtocolHeader, version)
			}))
			defer server.Close()
			ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Endpoints.BeefAPIVideoBaseURL = server.URL }))
			_, err := Execute(ctx, Input{Mode: "image", Prompt: "draw", Config: Config{BaseURL: server.URL, CredentialRef: "beefapi-enterprise", APIKey: "fixture", InterfaceType: "openai-image", Model: "opaque-future-2030"}, ReferenceImages: []Media{{StorageKey: "resource:must-not-read"}}})
			if err == nil || !strings.Contains(err.Error(), "尚未开始生成") || gets != 1 || posts != 0 {
				t.Fatalf("preflight: err=%v gets=%d posts=%d", err, gets, posts)
			}
		})
	}
}

func TestDirectImageFinalSerializationOwnsFormatAndReferenceShape(t *testing.T) {
	ctx := directImageTestContext()
	config := Config{BaseURL: "https://beeftv.app", CredentialRef: "beefapi-enterprise", InterfaceType: "openai-image", Model: "opaque-future-2030"}
	for _, plugin := range []bool{false, true} {
		body := map[string]any{"model": config.Model, "response_format": "b64_json", "image": "https://media.example/ref.png", "mask": "https://media.example/mask.png", "background": "transparent", "output_format": "png", "layer_decomposition": true}
		var data io.Reader
		if plugin {
			spec := protocol.RequestSpec{Path: "/v1/images/edits", ContentType: "application/json", Body: body}
			var err error
			data, _, err = ProtocolRequestBody(ctx, config, spec)
			if err != nil {
				t.Fatal(err)
			}
		} else {
			req, err := newJSONRequest(ctx, http.MethodPost, "https://beeftv.app/v1/images/edits", config, body)
			if err != nil {
				t.Fatal(err)
			}
			data = req.Body
		}
		var sent map[string]any
		if err := json.NewDecoder(data).Decode(&sent); err != nil {
			t.Fatal(err)
		}
		if sent["response_format"] != nil || sent["background"] != "transparent" || sent["layer_decomposition"] != true || len(sent["image"].([]any)) != 1 || body["response_format"] != "b64_json" {
			t.Fatalf("final body changed business/frozen fields: %#v", sent)
		}
	}
	for _, bad := range []any{"data:image/png;base64,Ynl0ZXM=", "http://media.example/plain.png", "https://user:pass@media.example/x.png", []any{[]any{"https://media.example/x.png"}}} {
		if _, err := directImageBody(ctx, "/v1/images/edits", map[string]any{"image": bad}); err == nil {
			t.Fatalf("non-HTTPS/inline reference accepted: %#v", bad)
		}
	}
}
