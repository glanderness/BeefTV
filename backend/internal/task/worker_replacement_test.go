package task

import (
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/mediatools"
	"testing"
)

func TestReplacementFinalOutputRejectsMissingFramesAndAudio(t *testing.T) {
	p := cw.ReplacementPlan{Width: 714, Height: 1280, FPS: 30, FrameCount: 422}
	f := mediatools.MediaMetadata{Width: 714, Height: 1280, FPS: 30, VideoFrames: 422, DurationMs: 14067, HasVideo: true, HasAudio: true}
	if err := validateReplacementOutput(p, f, true); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*mediatools.MediaMetadata){
		func(v *mediatools.MediaMetadata) { v.VideoFrames = 420 },
		func(v *mediatools.MediaMetadata) { v.Width = 720 },
		func(v *mediatools.MediaMetadata) { v.FPS = 24 },
		func(v *mediatools.MediaMetadata) { v.HasAudio = false },
		func(v *mediatools.MediaMetadata) { v.HasVideo = false },
	} {
		bad := f
		mutate(&bad)
		if err := validateReplacementOutput(p, bad, true); err == nil {
			t.Fatalf("accepted broken final media: %+v", bad)
		}
	}
}
