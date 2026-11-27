package editing

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExtensionForMIMEAndSniffing(t *testing.T) {
	mimeCases := map[string]string{
		"image/png":               ".png",
		"image/png; charset=utf8": ".png",
		"image/jpeg":              ".jpg",
		"image/jpg":               ".jpg",
		"image/webp":              ".webp",
		"image/gif":               ".gif",
		"video/mp4":               ".mp4",
		"video/quicktime":         ".mov",
		"video/x-m4v":             ".m4v",
		"video/webm":              ".webm",
		"video/x-matroska":        ".mkv",
		"audio/mpeg":              ".mp3",
		"audio/wav":               ".wav",
		"audio/x-wav":             ".wav",
		"audio/mp4":               ".m4a",
		"audio/x-m4a":             ".m4a",
		"audio/aac":               ".aac",
		"audio/flac":              ".flac",
		"audio/ogg":               ".ogg",
		"audio/opus":              ".opus",
		"application/unknown":     "",
	}
	for input, want := range mimeCases {
		if got := extensionForMIME(input); got != want {
			t.Fatalf("extensionForMIME(%q) = %q, want %q", input, got, want)
		}
	}

	if got := materializedSourceExtension("", []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0}, KindImage); got != ".png" {
		t.Fatalf("sniff PNG = %q, want .png", got)
	}
	if got := materializedSourceExtension("", []byte{0, 0, 0, 0x20, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}, KindAudio); got != ".m4a" {
		t.Fatalf("sniff M4A = %q, want .m4a", got)
	}
	if got := materializedSourceExtension("", []byte{0, 0, 0, 0x14, 'f', 't', 'y', 'p', 'q', 't', ' ', ' '}, KindVideo); got != ".mov" {
		t.Fatalf("sniff MOV = %q, want .mov", got)
	}
	if got := materializedSourceExtension("", []byte("OggS\x00\x02OpusHead"), KindAudio); got != ".opus" {
		t.Fatalf("sniff Opus = %q, want .opus", got)
	}
	if got := materializedSourceExtension("", []byte("unknown-bytes"), KindVideo); got != ".mp4" {
		t.Fatalf("fallback video = %q, want .mp4", got)
	}
	if got := materializedSourceExtension("", []byte("unknown-bytes"), KindAudio); got != ".bin" {
		t.Fatalf("fallback audio = %q, want .bin", got)
	}
}

func TestRendererEndToEndMixedVideoPNGImageM4AAudioAndSubtitleAt9x16(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required for real render integration test")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is required for real render integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir := t.TempDir()

	runFFmpeg := func(args ...string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		if out, runErr := cmd.CombinedOutput(); runErr != nil {
			t.Fatalf("ffmpeg %v failed: %v\n%s", args, runErr, out)
		}
	}

	// 1) Landscape video clip (2s) with 220Hz tone.
	videoPath := filepath.Join(dir, "clip-video.mp4")
	runFFmpeg("-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c=navy:s=640x360:r=30:d=2",
		"-f", "lavfi", "-i", "sine=frequency=220:duration=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoPath)

	// 2) Real still PNG image (320x320 solid coral).
	pngPath := filepath.Join(dir, "still-frame.png")
	img := image.NewRGBA(image.Rect(0, 0, 320, 320))
	for y := 0; y < 320; y++ {
		for x := 0; x < 320; x++ {
			img.Set(x, y, color.RGBA{R: 235, G: 96, B: 64, A: 255})
		}
	}
	pngFile, err := os.Create(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(pngFile, img); err != nil {
		pngFile.Close()
		t.Fatal(err)
	}
	if err := pngFile.Close(); err != nil {
		t.Fatal(err)
	}

	// 3) Real .m4a audio clip (4s, 440Hz tone).
	m4aPath := filepath.Join(dir, "bgm.m4a")
	runFFmpeg("-v", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=4",
		"-c:a", "aac", "-b:a", "96k", m4aPath)

	visible := true
	burn := true
	project := Project{
		Version:    ProjectVersion,
		DurationMs: 4000,
		Tracks: []Track{
			{ID: "v1", Kind: KindVideo, Visible: &visible},
			{ID: "a1", Kind: KindAudio, Visible: &visible},
			{ID: "s1", Kind: KindSubtitle, Visible: &visible},
		},
		Clips: []Clip{
			{
				ID: "clip-video", Kind: KindVideo, NodeID: "node-video", TrackID: "v1",
				StartMs: 0, DurationMs: 2000, Volume: 1,
				DirectMedia: &DirectMedia{ID: "res-video", Kind: KindVideo, StorageKey: "resource:res-video"},
			},
			{
				ID: "clip-image", Kind: KindImage, NodeID: "node-image", TrackID: "v1",
				StartMs: 2000, DurationMs: 2000, Volume: 1,
				DirectMedia: &DirectMedia{ID: "res-image", Kind: KindImage, StorageKey: "resource:res-image"},
			},
			{
				ID: "clip-audio", Kind: KindAudio, NodeID: "node-audio", TrackID: "a1",
				StartMs: 0, DurationMs: 4000, Volume: 0.75, FadeInMs: 250, FadeOutMs: 250,
				DirectMedia: &DirectMedia{ID: "res-audio", Kind: KindAudio, StorageKey: "resource:res-audio"},
			},
			{
				ID: "clip-sub", Kind: KindSubtitle, NodeID: "node-video", TrackID: "s1",
				StartMs: 500, DurationMs: 3000, Text: "竖屏图文音混剪验证",
			},
		},
	}

	sources := []SourceMeta{
		{ID: "res-video", Kind: KindVideo, DurationMs: 2000},
		{ID: "res-image", Kind: KindImage},
		{ID: "res-audio", Kind: KindAudio, DurationMs: 4000},
	}
	plan, err := Compile(project, sources, Options{Width: 1080, Height: 1920, FPS: 30, BurnSubtitles: &burn})
	if err != nil {
		t.Fatalf("Compile() error = %v", err)
	}

	fileMap := map[string]struct {
		path string
		mime string
	}{
		"res-video": {path: videoPath, mime: "video/mp4"},
		"res-image": {path: pngPath, mime: "image/png"},
		"res-audio": {path: m4aPath, mime: "audio/mp4"},
	}

	verifyOutput := func(t *testing.T, renderer *Renderer) {
		t.Helper()
		planCopy := *plan
		planCopy.Segments = append([]Segment(nil), plan.Segments...)
		planCopy.Audio = append([]AudioClip(nil), plan.Audio...)
		rendered, cleanup, renderErr := renderer.Render(ctx, &planCopy, nil)
		if cleanup != nil {
			defer cleanup()
		}
		if renderErr != nil {
			t.Fatalf("Renderer.Render() error = %v", renderErr)
		}
		if rendered.Width != 1080 || rendered.Height != 1920 {
			t.Fatalf("rendered dimensions = %dx%d, want 1080x1920", rendered.Width, rendered.Height)
		}

		probeOut, probeErr := exec.CommandContext(ctx, ffprobe,
			"-v", "error",
			"-show_entries", "stream=codec_type,width,height:format=duration",
			"-of", "json", rendered.Path,
		).Output()
		if probeErr != nil {
			t.Fatalf("ffprobe rendered output: %v", probeErr)
		}
		var probed struct {
			Streams []struct {
				CodecType string `json:"codec_type"`
				Width     int    `json:"width"`
				Height    int    `json:"height"`
			} `json:"streams"`
			Format struct {
				Duration string `json:"duration"`
			} `json:"format"`
		}
		if err := json.Unmarshal(probeOut, &probed); err != nil {
			t.Fatalf("unmarshal ffprobe output: %v\n%s", err, probeOut)
		}
		hasVideo, hasAudio := false, false
		var width, height int
		for _, stream := range probed.Streams {
			switch stream.CodecType {
			case "video":
				hasVideo = true
				width, height = stream.Width, stream.Height
			case "audio":
				hasAudio = true
			}
		}
		if !hasVideo || !hasAudio {
			t.Fatalf("probed streams missing video or audio: %+v", probed.Streams)
		}
		if width != 1080 || height != 1920 {
			t.Fatalf("ffprobe video dimensions = %dx%d, want 1080x1920", width, height)
		}
		seconds, convErr := parseProbeSeconds(probed.Format.Duration)
		if convErr != nil || math.Abs(seconds-4.0) > 0.3 {
			t.Fatalf("ffprobe duration = %q (%.3fs), want ~4.0s", probed.Format.Duration, seconds)
		}
	}

	t.Run("with-explicit-mime-provider", func(t *testing.T) {
		renderer := &Renderer{
			FFmpeg: ffmpeg,
			Sources: NewMIMEOpener(func(_ context.Context, sourceID string) (io.ReadCloser, string, error) {
				entry, ok := fileMap[sourceID]
				if !ok {
					return nil, "", os.ErrNotExist
				}
				file, openErr := os.Open(entry.path)
				return file, entry.mime, openErr
			}),
		}
		verifyOutput(t, renderer)
	})

	t.Run("with-magic-byte-sniffing-opener", func(t *testing.T) {
		renderer := &Renderer{
			FFmpeg: ffmpeg,
			Sources: fileSources{
				"res-video": videoPath,
				"res-image": pngPath,
				"res-audio": m4aPath,
			},
		}
		verifyOutput(t, renderer)
	})
}
