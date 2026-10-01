package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/editing"
)

func renderClipFixture(id string, kind string, trackID string, startMs int64, durationMs int64, storageKey string) renderClip {
	clip := renderClip{ID: id, Kind: kind, TrackID: trackID, StartMs: startMs, DurationMs: durationMs, Volume: 1}
	if storageKey != "" {
		clip.DirectMedia = &editing.DirectMedia{ID: "media-" + id, Kind: kind, StorageKey: storageKey}
	}
	return clip
}

func mustBuildRenderPlan(t *testing.T, project renderProject) *editing.Plan {
	t.Helper()
	plan, err := buildRenderPlan(project)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestBuildRenderPlanExpandsGapAndSorts(t *testing.T) {
	project := renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-video-1", Kind: "video"}},
		Clips: []renderClip{
			renderClipFixture("clip-b", "video", "track-video-1", 3000, 2000, "resource:res-b"),
			renderClipFixture("clip-a", "video", "track-video-1", 0, 2000, "resource:res-a"),
			renderClipFixture("clip-sub", "subtitle", "track-subtitle-1", 0, 1000, ""),
		},
	}
	plan := mustBuildRenderPlan(t, project)
	if !plan.HasMedia() {
		t.Fatal("HasMedia = false, want true")
	}
	if len(plan.Segments) != 3 {
		t.Fatalf("segments = %d, want 3 (clip-a, gap, clip-b)", len(plan.Segments))
	}
	if plan.Segments[0].Kind != "video" || plan.Segments[0].ClipID != "clip-a" {
		t.Fatalf("seg0 = %s/%s, want video/clip-a", plan.Segments[0].Kind, plan.Segments[0].ClipID)
	}
	if plan.Segments[1].Kind != "gap" || plan.Segments[1].DurationMs != 1000 {
		t.Fatalf("seg1 = %s/%dms, want gap/1000ms", plan.Segments[1].Kind, plan.Segments[1].DurationMs)
	}
	if plan.Segments[2].ClipID != "clip-b" {
		t.Fatalf("seg2 = %s, want clip-b (sorted by startMs)", plan.Segments[2].ClipID)
	}
}

func TestBuildRenderPlanSkipsHiddenTrack(t *testing.T) {
	hidden := false
	project := renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-hidden", Kind: "video", Visible: &hidden}},
		Clips:   []renderClip{renderClipFixture("clip-hidden", "video", "track-hidden", 0, 1000, "resource:res-x")},
	}
	plan, err := buildRenderPlan(project)
	if err == nil || !planHasNoMedia(plan, err) {
		t.Fatalf("hidden-only: plan=%v err=%v", plan, err)
	}
}

func planHasNoMedia(plan *editing.Plan, err error) bool {
	if err != nil && strings.Contains(err.Error(), "可渲染") {
		return true
	}
	return plan != nil && !plan.HasMedia()
}

func TestBuildRenderSubtitleSRT(t *testing.T) {
	project := renderProject{
		Version: 2,
		Clips: []renderClip{
			{ID: "sub-b", Kind: "subtitle", StartMs: 2000, DurationMs: 1000, Text: "第二条"},
			{ID: "sub-a", Kind: "subtitle", StartMs: 0, DurationMs: 1000, Text: "第一条"},
			{ID: "sub-blank", Kind: "subtitle", StartMs: 5000, DurationMs: 1000, Text: "   "},
		},
	}
	srt := buildRenderSubtitleSRT(project)
	want := "1\n00:00:00,000 --> 00:00:01,000\n第一条\n\n2\n00:00:02,000 --> 00:00:03,000\n第二条\n\n"
	if srt != want {
		t.Fatalf("srt mismatch:\n got %q\nwant %q", srt, want)
	}
	if buildRenderSubtitleSRT(renderProject{Version: 2}) != "" {
		t.Fatal("srt for empty timeline: want empty string")
	}
}

func TestBuildRenderFFmpegArgsLayout(t *testing.T) {
	plan := mustBuildRenderPlan(t, renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-video-1", Kind: "video"}},
		Clips: []renderClip{
			renderClipFixture("clip-a", "video", "track-video-1", 0, 2000, "resource:res-a"),
			renderClipFixture("clip-b", "video", "track-video-1", 5000, 1000, "resource:res-b"),
		},
	})
	plan.Segments[0].HasAudio = true
	plan.Segments[2].HasAudio = true
	files := map[string]string{plan.Segments[0].SourceID: "src-0.mp4", plan.Segments[2].SourceID: "src-1.mp4"}

	args := buildRenderFFmpegArgs(*plan, files, "render-output.mp4")
	joined := strings.Join(args, " ")
	if len(args) == 0 {
		t.Fatal("args empty, want ffmpeg arguments")
	}
	for _, want := range []string{
		"-filter_complex",
		"concat=n=3:v=1:a=1",
		"[vout]", "[aout]",
		"libx264", "aac",
		"color=c=black:s=1920x1080:r=30",
		"anullsrc=r=44100:cl=stereo",
		"render-output.mp4",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %s", want, joined)
		}
	}
	if !strings.Contains(joined, "[5:a]") {
		t.Fatalf("args missing final audio input label [5:a]: %s", joined)
	}
	if buildRenderFFmpegArgs(editing.Plan{}, nil, "out.mp4") != nil {
		t.Fatal("args for empty plan: want nil")
	}
}

func TestBuildRenderFFmpegArgsSilentFallbackUniqueLabels(t *testing.T) {
	plan := editing.Plan{
		Output:     editing.Output{Width: 1920, Height: 1080, FPS: 30, SampleRate: 44100},
		DurationMs: 2000,
		Segments: []editing.Segment{
			{Kind: "video", SourceID: "a", DurationMs: 1000, HasAudio: false, Volume: 1},
			{Kind: "video", SourceID: "b", DurationMs: 1000, HasAudio: false, Volume: 1},
		},
	}
	args := buildRenderFFmpegArgs(plan, map[string]string{"a": "src-0.mp4", "b": "src-1.mp4"}, "out.mp4")
	joined := strings.Join(args, " ")
	if strings.Count(joined, "-i anullsrc=") != 2 || strings.Count(joined, "apad,atrim=duration=1.000") != 2 {
		t.Fatalf("silent labels not unique: %s", joined)
	}
}

func TestMediaResourceID(t *testing.T) {
	clip := renderClipFixture("a", "video", "track-1", 0, 1000, "resource:res-42")
	if id, ok := mediaResourceID(clip); !ok || id != "res-42" {
		t.Fatalf("mediaResourceID = %q/%v, want res-42/true", id, ok)
	}
	if _, ok := mediaResourceID(renderClip{}); ok {
		t.Fatal("mediaResourceID for clip without directMedia: want false")
	}
	if _, ok := mediaResourceID(renderClipFixture("a", "video", "track-1", 0, 1000, "https://example.com/a.mp4")); ok {
		t.Fatal("mediaResourceID for http storage key: want false")
	}
}
