package editing

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

func TestBuildFFmpegArgsLayout(t *testing.T) {
	plan, err := Compile(Project{
		Version: 2,
		Tracks:  []Track{{ID: "track-video-1", Kind: KindVideo}},
		Clips: []Clip{
			clip("clip-a", KindVideo, "track-video-1", 0, 2000, "resource:res-a"),
			clip("clip-b", KindVideo, "track-video-1", 5000, 1000, "resource:res-b"),
		},
	}, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	plan.Segments[0].HasAudio = true
	plan.Segments[2].HasAudio = true
	files := map[string]string{plan.Segments[0].SourceID: "src-0.mp4", plan.Segments[2].SourceID: "src-1.mp4"}

	args := BuildFFmpegArgs(*plan, files, "render-output.mp4")
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
	if BuildFFmpegArgs(Plan{}, nil, "out.mp4") != nil {
		t.Fatal("args for empty plan: want nil")
	}
}

func TestBuildFFmpegArgsSilentFallbackUniqueLabels(t *testing.T) {
	plan := Plan{
		Output:     Output{Width: 1920, Height: 1080, FPS: 30, SampleRate: 44100},
		DurationMs: 2000,
		Segments: []Segment{
			{Kind: KindVideo, SourceID: "a", DurationMs: 1000, HasAudio: false, Volume: 1},
			{Kind: KindVideo, SourceID: "b", DurationMs: 1000, HasAudio: false, Volume: 1},
		},
	}
	args := BuildFFmpegArgs(plan, map[string]string{"a": "src-0.mp4", "b": "src-1.mp4"}, "out.mp4")
	joined := strings.Join(args, " ")
	if strings.Count(joined, "-i anullsrc=") != 2 || strings.Count(joined, "apad,atrim=duration=1.000") != 2 {
		t.Fatalf("silent labels not unique: %s", joined)
	}
}

func TestBuildFFmpegArgsMissingSourceReturnsNil(t *testing.T) {
	plan := Plan{
		Output:     Output{Width: 1920, Height: 1080, FPS: 30, SampleRate: 44100},
		DurationMs: 1000,
		Segments:   []Segment{{Kind: KindVideo, SourceID: "missing", DurationMs: 1000, Volume: 1}},
	}
	if args := BuildFFmpegArgs(plan, nil, "x.mp4"); args != nil {
		t.Fatal("missing source must fail")
	}
}

func TestSubtitleFontFailure(t *testing.T) {
	if !SubtitleFontFailure("fontselect: failed to find any fallback with glyph 0x4E2D") || SubtitleFontFailure("fontselect: using Chinese font") {
		t.Fatal("font failure detection")
	}
	for _, message := range []string{
		"can't find selected font provider", "fontselect: failed to find any fallback with glyph 0x4E2D",
		"couldn't find font family", "missing glyph 0x4E2D", "no fonts found",
	} {
		if !SubtitleFontFailure(message) {
			t.Fatalf("successful exit masked missing subtitles: %s", message)
		}
	}
	for _, normal := range []string{
		"Glyph 0x4E2D not found, selecting one more font for (Arial, 400, 0)",
		"fontselect: (Arial, 400, 0) -> NotoSansCJK, 0, NotoSansCJK",
	} {
		if SubtitleFontFailure(normal) {
			t.Fatalf("normal fallback rejected: %s", normal)
		}
	}
}

type fileSources map[string]string

func (s fileSources) Open(_ context.Context, sourceID string) (io.ReadCloser, error) {
	path := s[sourceID]
	if path == "" {
		return nil, os.ErrNotExist
	}
	return os.Open(path)
}

func TestRendererMaterializeMissingSource(t *testing.T) {
	plan := &Plan{Segments: []Segment{{Kind: KindVideo, ClipID: "missing", SourceID: "missing", DurationMs: 1000, Volume: 1}}}
	renderer := &Renderer{}
	if _, cleanup, err := renderer.Render(context.Background(), plan, nil); err == nil {
		if cleanup != nil {
			cleanup()
		}
		t.Fatal("missing reference accepted")
	} else if !strings.Contains(err.Error(), "时间线引用的媒体") && err != ErrNoMedia {
		t.Fatalf("err=%v", err)
	}
}

func TestRendererRejectsEmptyPlan(t *testing.T) {
	renderer := &Renderer{FFmpeg: "/no/such/ffmpeg"}
	if _, cleanup, err := renderer.Render(context.Background(), &Plan{}, nil); err != ErrNoMedia {
		if cleanup != nil {
			cleanup()
		}
		t.Fatalf("err=%v want ErrNoMedia", err)
	}
}
