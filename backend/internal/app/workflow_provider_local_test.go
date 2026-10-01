package app

import (
	"context"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestRunningHubWorkflowRejectsMediaUploadInLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	input := canvasGenerationInput{
		Mode: "video",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceRunningHubVideo),
			BaseURL:       "https://example.com",
		},
		ReferenceImages: []providerMedia{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA"}},
	}
	_, err := svc.runRunningHubWorkflow(context.Background(), input)
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local RunningHub media upload error = %v, want local-workspace rejection", err)
	}
}

func TestUploadRunningHubMediaRejectsLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	_, err := svc.uploadRunningHubMedia(context.Background(), "https://example.com", providerConfig{}, providerMedia{
		ID:      "ref-1",
		DataURL: "data:image/png;base64,AAAA",
	})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local RunningHub upload error = %v, want local-workspace rejection", err)
	}
}

func TestWorkflowPluginsNilServiceFailsClosed(t *testing.T) {
	err := (workflowPlugins{}).EnsureEnabled(context.Background(), string(model.ChannelInterfaceRunningHubImage))
	if err == nil || !strings.Contains(err.Error(), "插件授权") {
		t.Fatalf("nil plugin service error = %v, want fail closed", err)
	}
}

func TestWorkflowReceiptNilServiceFailsClosed(t *testing.T) {
	err := (workflowReceipt{}).RecordAccepted(context.Background(), "accepted-1", "submitted", nil)
	if err == nil || !strings.Contains(err.Error(), "受理回执") {
		t.Fatalf("nil receipt service error = %v, want fail closed", err)
	}
}
