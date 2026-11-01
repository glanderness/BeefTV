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
)

func TestReferenceStorageFailureProvesNoModelSubmission(t *testing.T) {
	for _, cause := range []error{
		errors.New("anonymous GET HTTP 403 denied https://private.invalid/?token=secret"),
		errors.New("PUT HTTP 401 denied"),
		errors.New("HTTP 502 gateway unavailable"),
		context.DeadlineExceeded,
		io.ErrUnexpectedEOF,
	} {
		t.Run(cause.Error(), func(t *testing.T) {
			var events []string
			storage := &referenceStorageFixture{failure: cause}
			ctx := WithRuntime(context.Background(), Runtime{Resources: stageResources{events: &events}, ReferenceStorage: storage})
			input := Input{Mode: "video", Config: Config{InterfaceType: "newapi-channel-2"}, ReferenceVideos: []Media{{StorageKey: "resource:one"}}}
			if err := ValidateMediaTransport(ctx, input); err != nil || storage.uploads != 0 {
				t.Fatalf("admission must not upload: %v", err)
			}
			err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input))
			var preparation RequestPreparationError
			if !errors.As(err, &preparation) || !errors.Is(err, cause) || storage.uploads != 1 {
				t.Fatalf("lost preparation evidence: %v", err)
			}
			failure := ClassifyError(err)
			if failure.Category != CategoryProviderUnavailable || failure.ProviderCode != "reference_media_upload_failed" || failure.Uncertain || failure.Retryable {
				t.Fatalf("storage failure became provider rejection or unknown submission: %#v", failure)
			}
			message := failure.UserMessage()
			if !strings.Contains(message, "本次尚未开始生成") || !strings.Contains(message, "公开读取权限") || strings.Contains(message, "private.invalid") || strings.Contains(message, "secret") || strings.Contains(message, "模型的权限") {
				t.Fatalf("unsafe or misleading failure: %q", message)
			}
			var unknown SubmissionUnknownError
			if errors.As(UncertainVideoSubmission(ctx, err), &unknown) {
				t.Fatal("preparation failure became an unknown paid create")
			}
			if retry, _ := RetryableVideoPollError(ctx, err); retry {
				t.Fatal("reference preparation failure entered provider polling retries")
			}
		})
	}
}

func TestReferenceStorageFailureStopsBeforeModelDispatch(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	var events []string
	storage := &referenceStorageFixture{failure: errors.New("anonymous GET HTTP 403 denied")}
	runtime := taskRuntime(func(r *Runtime) {
		r.Config = stageConfig{events: &events}
		r.Resources = stageResources{events: &events}
		r.ReferenceStorage = storage
	})
	input := Input{Mode: "text", Prompt: "describe", Config: Config{BaseURL: server.URL, APIKey: "test", Model: "text", ReferenceMediaTransport: map[string]string{"image": "url"}}, ReferenceImages: []Media{{StorageKey: "resource:one"}}}
	_, err := Execute(WithRuntime(context.Background(), runtime), input)
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) || storage.uploads != 1 || requests.Load() != 0 {
		t.Fatalf("storage failure reached model dispatch: uploads=%d requests=%d error=%v", storage.uploads, requests.Load(), err)
	}
}

type expiringBatchStorage struct {
	referenceStorageFixture
	validated bool
}

func (s *expiringBatchStorage) ValidateReferences(context.Context) error {
	s.validated = true
	return errors.New("an earlier reference expired during the batch")
}

func TestBatchExpiryStopsBeforePaidModelDispatch(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	var events []string
	storage := &expiringBatchStorage{}
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "owner"
		r.Config = stageConfig{events: &events}
		r.Resources = stageResources{events: &events}
		r.SelectReferenceStorage = func(config Config) ReferenceStoragePort {
			if config.CredentialRef == "host:managed" {
				return storage
			}
			return nil
		}
	})
	input := Input{Mode: "text", Prompt: "describe", Config: Config{BaseURL: server.URL, APIKey: "test", Model: "text", CredentialRef: "host:managed", ReferenceMediaTransport: map[string]string{"image": "url", "video": "url"}}, ReferenceImages: []Media{{StorageKey: "resource:one"}}, ReferenceVideos: []Media{{StorageKey: "resource:one"}}}
	_, err := Execute(WithRuntime(context.Background(), runtime), input)
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) || !storage.validated || storage.uploads != 2 || requests.Load() != 0 {
		t.Fatalf("expired batch reached model dispatch: uploads=%d validated=%v requests=%d error=%v", storage.uploads, storage.validated, requests.Load(), err)
	}

	// A user-supplied channel keeps the official inline transport; the host
	// selector must not route its media through managed platform storage.
	storage.validated = false
	input.Config.CredentialRef = ""
	input.Config.ReferenceMediaTransport = nil
	ctx := WithRuntime(context.Background(), runtime)
	if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicy{}); err != nil {
		t.Fatal(err)
	}
	if storage.validated || storage.uploads != 2 || !strings.HasPrefix(input.ReferenceImages[0].DataURL, "data:") {
		t.Fatal("managed storage changed the user-supplied channel")
	}
}
