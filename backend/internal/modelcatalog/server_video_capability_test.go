package modelcatalog

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestServerVideoCapabilityDoesNotApplyModelOrHostLimits(t *testing.T) {
	for _, name := range []string{"seedance-2.0", "seedance-2.5", "dreamina-seedance-2-5-260628", "agnes-video-2.5", "unseen-video"} {
		t.Run(name, func(t *testing.T) {
			version := "server-v2"
			profile := DefaultModelCapabilityConfigForModel("openai-videos", "unseen-video")
			profile.Video.References = VideoReferenceConfig{MaxImages: 12, MaxVideos: 5, MaxAudios: 5}
			profile.Video.GenerateAudio = VideoBooleanConfig{Supported: false, Default: false}
			profile.Video.Duration = VideoDurationConfig{Selection: "range", Min: 1, Max: 3, Step: 1, Default: 1}
			profile.Video.Operations = []string{"text_to_video", "image_to_video", "reference_to_video", "audio_to_video"}
			draft, err := NormalizeModelCapabilityDraft(ModelCapabilityDraft{ChannelID: "beefapi", BaseURL: "https://enterprise.beefapi.com", Protocol: "newapi", Model: name, Capability: "video", CapabilityConfig: profile, VideoCapabilitiesVersion: &version})
			if err != nil {
				t.Fatal(err)
			}
			if draft.Video.References != profile.Video.References || draft.Video.Duration.Min != 1 || draft.Video.GenerateAudio.Supported {
				t.Fatal("server declaration was overwritten")
			}
			input := TaskInput{Config: TaskConfig{ChannelID: "beefapi", BaseURL: "https://enterprise.beefapi.com", InterfaceType: "newapi", Model: name, VideoCapabilitiesVersion: &version, VideoSeconds: "1"}, ReferenceImages: []MediaRef{{Width: 64, Height: 64, Bytes: 100 << 20}}}
			if err := ValidateVideoTask(draft.Video, input); err != nil {
				t.Fatalf("invented a size or duration restriction: %v", err)
			}
			input.Mode = "video"
			input.Config.ChannelID = ""
			input.Config.CapabilityConfig = draft
			if name == "agnes-video-2.5" {
				input.Config.InterfaceType = "agnes-video"
			}
			if _, err := ValidateConfiguredTask(input, nil); err != nil {
				t.Fatalf("admission rewrote the server declaration: %v", err)
			}
			// Explicit zero is authoritative even for previously supported inputs.
			draft.Video.References.MaxImages = 0
			if err := ValidateVideoTask(draft.Video, input); err == nil {
				t.Fatal("explicit zero reference count was ignored")
			}
		})
	}
}

func TestUnversionedBYOKVideoRetainsItsDocumentedLimits(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0").Video
	input := TaskInput{Config: TaskConfig{BaseURL: "https://example.com", InterfaceType: "newapi", Model: "seedance-2.0", VideoSeconds: "1"}}
	if err := ValidateVideoTask(profile, input); err == nil {
		t.Fatal("BYOK duration validation changed")
	}
}

func TestServerVideoOperationReferencesUseExplicitOperation(t *testing.T) {
	body, err := os.ReadFile("../beefapi/testdata/managed-video-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Data []struct {
			ID      string                 `json:"id"`
			Video   *VideoCapabilityConfig `json:"video_capabilities"`
			Version string                 `json:"video_capabilities_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &catalog); err != nil {
		t.Fatal(err)
	}
	for _, row := range catalog.Data {
		if row.ID != "wan3.0-video" {
			continue
		}
		profile := row.Video
		if err := ValidateVideoCapabilityConfig(profile); err != nil {
			t.Fatal(err)
		}
		input := TaskInput{Config: TaskConfig{Model: "unknown-video", VideoCapabilitiesVersion: &row.Version, VideoSeconds: "5"}, ReferenceImages: make([]MediaRef, 3), Metadata: map[string]any{"videoEditOperation": "image_to_video"}}
		for _, validate := range []func(*VideoCapabilityConfig, TaskInput) error{ValidateVideoTask, ValidateVideoTaskParameters} {
			if err := validate(profile, input); err == nil || !strings.Contains(err.Error(), "2 张参考图") {
				t.Fatalf("operation image cap ignored: %v", err)
			}
			input.Metadata["videoEditOperation"] = "reference_to_video"
			input.ReferenceImages = make([]MediaRef, 10)
			if err := validate(profile, input); err != nil {
				t.Fatal(err)
			}
			input.Metadata["videoEditOperation"] = "image_to_video"
			input.ReferenceImages = make([]MediaRef, 2)
			input.ReferenceVideos = []MediaRef{{}}
			if err := validate(profile, input); err == nil || !strings.Contains(err.Error(), "0 个参考视频") {
				t.Fatalf("operation zero ignored: %v", err)
			}
			input.ReferenceVideos = nil
			input.ReferenceImages = make([]MediaRef, 3)
			delete(input.Metadata, "videoEditOperation")
			if err := validate(profile, input); err != nil {
				t.Fatalf("legacy request must use global limits: %v", err)
			}
			input.Metadata["videoEditOperation"] = "image_to_video"
		}
		if profile.References.MaxImages != 10 {
			t.Fatal("operation validation mutated global attachment capacity")
		}
		return
	}
	t.Fatal("Wan fixture missing")
}
