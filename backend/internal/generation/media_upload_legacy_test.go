package generation

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/beeftv"
	"testing"
)

func CompleteBeefTVSeedanceUpload(ctx context.Context, config Config, session BeefTVSeedanceUploadSession, data []byte) (BeefTVSeedanceUploadComplete, error) {
	uploaded, err := managedMediaClient(ctx, config).CompleteUpload(ctx, session, data, "参考素材")
	if err != nil {
		return uploaded, referenceMediaUploadError(ctx, err)
	}
	return uploaded, nil
}

func PutBeefTVSeedanceBytes(ctx context.Context, session BeefTVSeedanceUploadSession, data []byte) error {
	client := managedMediaClient(ctx, Config{})
	var dispatched bool
	var phase string
	observe := client.StorageObserve
	client.StorageObserve = func(value beeftv.UploadObservation) {
		dispatched, phase = value.Dispatched, value.Phase
		if observe != nil {
			observe(value)
		}
	}
	err := client.PutUploadBytes(ctx, session, data)
	if err != nil {
		upload := referenceUploadError(referenceUploadStage(ctx, "put"), legacyMediaError(err))
		upload.Dispatched, upload.TransportPhase = dispatched, phase
		return upload
	}
	return nil
}

func ValidateBeefTVSeedanceSecureURL(ctx context.Context, raw string) error {
	runtime, _ := RuntimeFromContext(ctx)
	return (&beeftv.MediaClient{AllowHTTPTest: runtime.Endpoints.BeefTVVideoBaseURL != ""}).ValidateUploadURL(ctx, raw)
}

func completeBeefTVSeedanceMultipart(ctx context.Context, config Config, session BeefTVSeedanceUploadSession, data []byte) (BeefTVSeedanceUploadComplete, error) {
	return CompleteBeefTVSeedanceUpload(ctx, config, session, data)
}
func retrySeedanceUpload(ctx context.Context, err error, _ bool) bool {
	return ctx.Err() == nil && beeftv.RetryUploadError(err)
}

func TestPrepareBeefTVVideoReferencesSkipsTextAndAudioTasks(t *testing.T) {
	cfg := Config{
		BaseURL:       "https://beeftv.app/v1",
		APIKey:        "test-key",
		Model:         "claude-fable-5",
		CredentialRef: beeftv.CredentialRef,
	}
	for _, mode := range []string{"text", "audio"} {
		input := Input{
			Mode:            mode,
			Config:          cfg,
			ReferenceImages: []Media{{DataURL: "data:image/png;base64,aGVsbG8=", MimeType: "image/png"}},
		}
		err := PrepareBeefTVVideoReferences(context.Background(), cfg, &input, func(string, Media) ([]byte, string, bool, error) {
			return nil, "", false, errors.New("must not read or preupload reference media for non-video mode")
		})
		if err != nil {
			t.Fatalf("mode %q: unexpected error: %v", mode, err)
		}
		if input.ReferenceImages[0].DataURL == "" {
			t.Fatalf("mode %q: cleared inline DataURL", mode)
		}
	}
}
