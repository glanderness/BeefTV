package generation

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func directImageTestContext() context.Context {
	ctx := context.WithValue(context.Background(), imageMediaContext{}, ImageMediaProtocol)
	return context.WithValue(ctx, imageMediaRequiredContext{}, "https://beeftv.app")
}

func TestManagedImageProtocolHasNoModelAllowlist(t *testing.T) {
	for _, name := range []string{"gpt-image-2", "midjourney-v8.2", "hy-image-v3", "dola-seedream-5-0-pro-260628", "opaque-future-2030"} {
		config := Config{BaseURL: "https://beeftv.app", CredentialRef: "beefapi-enterprise", InterfaceType: "openai-image", Model: name}
		if usesDirectImageMedia(context.Background(), config) || !usesDirectImageMedia(directImageTestContext(), config) {
			t.Fatalf("%s did not require advertised protocol", name)
		}
		config.CredentialRef = ""
		if usesDirectImageMedia(directImageTestContext(), config) {
			t.Fatal("custom connection changed with hostname alone")
		}
	}
}

func TestManagedOpenAIEditKeepsReferenceAndMaskURLs(t *testing.T) {
	refs := []protocol.RequestFilePart{
		{Name: "image", Reference: protocol.MediaReference{URL: "https://media.example/one.png"}},
		{Name: "image", Reference: protocol.MediaReference{URL: "https://media.example/two.png"}},
		{Name: "mask", Reference: protocol.MediaReference{URL: "https://media.example/mask.png"}},
	}
	config := Config{BaseURL: "https://beeftv.app", CredentialRef: "beefapi-enterprise", InterfaceType: "openai-image", Model: "opaque-future-2030"}
	spec := protocol.RequestSpec{Path: "/v1/images/edits", ContentType: "multipart/form-data", Body: map[string]any{"model": config.Model, "output_format": "png", "background": "transparent", "response_format": "b64_json"}, Files: refs}
	converted, err := managedImageRequestSpec(directImageTestContext(), config, spec)
	if err != nil {
		t.Fatal(err)
	}
	body := ProtocolBodyObject(converted.Body)
	if converted.ContentType != "application/json" || converted.Files != nil || body["mask"] != refs[2].Reference.URL || !reflect.DeepEqual(body["image"], []string{refs[0].Reference.URL, refs[1].Reference.URL}) || body["background"] != "transparent" || body["output_format"] != "png" {
		t.Fatalf("managed JSON contract lost: %#v", converted)
	}
	if spec.ContentType != "multipart/form-data" || len(spec.Files) != 3 || ProtocolBodyObject(spec.Body)["response_format"] != "b64_json" {
		t.Fatal("conversion mutated original request or frozen options")
	}
	spec.Files = []protocol.RequestFilePart{{Name: "image", Reference: protocol.MediaReference{DataURL: DataURL("image/png", []byte("inline"))}}}
	if _, _, err := ProtocolRequestBody(directImageTestContext(), config, spec); err == nil {
		t.Fatal("managed edit allowed inline bytes after upload preparation")
	}
}

func TestThirdPartyOpenAIEditPreservesMultipartBytes(t *testing.T) {
	data := []byte("original image bytes")
	spec := protocol.RequestSpec{Path: "/v1/images/edits", ContentType: "multipart/form-data", Body: map[string]any{"model": "gpt-image-2", "response_format": "b64_json"}, Files: []protocol.RequestFilePart{{Name: "image", Filename: "source.png", Reference: protocol.MediaReference{DataURL: DataURL("image/png", data)}}}}
	body, contentType, err := ProtocolRequestBody(context.Background(), Config{BaseURL: "https://third-party.example", InterfaceType: "openai-image", Model: "gpt-image-2"}, spec)
	if err != nil {
		t.Fatal(err)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(body, params["boundary"])
	found := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		value, _ := io.ReadAll(part)
		if part.FormName() == "image" {
			found = true
			if !bytes.Equal(value, data) || part.FileName() != "source.png" {
				t.Fatal("third-party multipart changed")
			}
		}
		if part.FormName() == "response_format" && string(value) != "b64_json" {
			t.Fatal("third-party response format changed")
		}
	}
	if !found {
		t.Fatal("third-party source file missing")
	}
}

func TestManagedImagePublicURLSkipsUploadAndRemovesDuplicateInlineData(t *testing.T) {
	input := Input{Mode: "image", Config: Config{BaseURL: "https://beeftv.app", CredentialRef: "beefapi-enterprise", InterfaceType: "openai-image", Model: "opaque-future-2030"}, ReferenceImages: []Media{{URL: "https://media.example/one.png", DataURL: DataURL("image/png", []byte("do not send"))}}, Mask: &Media{URL: "https://media.example/mask.png"}}
	if err := prepareBeefAPIImageReferences(directImageTestContext(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].URL != "https://media.example/one.png" || input.ReferenceImages[0].DataURL != "" || input.Mask.URL != "https://media.example/mask.png" {
		t.Fatalf("public URLs changed: %#v", input)
	}
}

func TestManagedImageUploadFailureNeverDispatchesGeneration(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, status := range []int{http.StatusNotFound, http.StatusNotImplemented, http.StatusBadRequest, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/models") {
					w.Header().Set(ImageMediaProtocolHeader, ImageMediaProtocol)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/images/edits") {
					posts.Add(1)
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Endpoints.BeefAPIVideoBaseURL = server.URL }))
			input := Input{Mode: "image", Prompt: "edit", Config: Config{BaseURL: server.URL, CredentialRef: "beefapi-enterprise", InterfaceType: "openai-image", Model: "opaque-future-2030", APIKey: "synthetic"}, ReferenceImages: []Media{{DataURL: DataURL("image/png", []byte("image"))}}}
			_, err := Execute(WithProtocolRegistry(ctx, LoadOfficialFallbackRegistry()), input)
			var preparation RequestPreparationError
			if !errors.As(err, &preparation) || posts.Load() != 0 {
				t.Fatalf("upload failure reached generation, posts=%d error=%v", posts.Load(), err)
			}
		})
	}
}

func TestManagedImageUploadUsesModelLimitInsteadOfSeedanceLimit(t *testing.T) {
	input := Input{}
	if err := validateManagedImageReference(&input, 48<<20); err != nil {
		t.Fatalf("image inherited video upload limit: %v", err)
	}
	profile := ImageCapabilityConfig{}
	profile.References.MaxImageBytes = 10 << 20
	input.ImageCapability = &profile
	if err := validateManagedImageReference(&input, 10<<20+1); err == nil {
		t.Fatal("actual model limit ignored")
	}
}

func TestManagedImageFailedPUTOrCompletionStopsBeforeGeneration(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, failingStage := range []string{"put", "complete"} {
		t.Run(failingStage, func(t *testing.T) {
			var creates, puts, completes, generations atomic.Int32
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/models"):
					w.Header().Set(ImageMediaProtocolHeader, ImageMediaProtocol)
				case strings.HasSuffix(r.URL.Path, "/video-references/uploads/complete"):
					completes.Add(1)
					w.WriteHeader(http.StatusBadRequest)
					_, _ = io.WriteString(w, `{"error":{"code":"video_reference_upload_incomplete","message":"not received"}}`)
				case strings.HasSuffix(r.URL.Path, "/video-references/uploads"):
					creates.Add(1)
					_, _ = io.WriteString(w, `{"ticket":"original-ticket","upload_url":"`+server.URL+`/object","upload_method":"PUT"}`)
				case r.Method == http.MethodPut:
					puts.Add(1)
					if failingStage == "put" {
						w.WriteHeader(http.StatusForbidden)
					}
				default:
					generations.Add(1)
					w.WriteHeader(http.StatusInternalServerError)
				}
			}))
			defer server.Close()
			ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Endpoints.BeefAPIVideoBaseURL = server.URL }))
			input := Input{Mode: "image", Prompt: "edit", Config: Config{BaseURL: server.URL, CredentialRef: "beefapi-enterprise", InterfaceType: "openai-image", Model: "opaque-future-2030", APIKey: "synthetic"}, ReferenceImages: []Media{{DataURL: DataURL("image/png", []byte("image"))}}}
			_, err := Execute(WithProtocolRegistry(ctx, LoadOfficialFallbackRegistry()), input)
			var preparation RequestPreparationError
			if !errors.As(err, &preparation) || generations.Load() != 0 || creates.Load() != 1 || puts.Load() != 1 {
				t.Fatalf("failed storage reached paid create: creates=%d puts=%d completes=%d model=%d error=%v", creates.Load(), puts.Load(), completes.Load(), generations.Load(), err)
			}
			if failingStage == "put" && completes.Load() != 0 {
				t.Fatal("permanent PUT rejection was confirmed")
			}
			if failingStage == "complete" && completes.Load() != 1 {
				t.Fatal("completion rejection did not stop preparation")
			}
		})
	}
}
