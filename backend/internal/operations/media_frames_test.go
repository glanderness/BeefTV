package operations

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	_ "image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestMediaFrameSampleTimestampsFirstMidTailAndShortClamp(t *testing.T) {
	got := frameSampleTimestamps(0, 2000, 3)
	if len(got) != 3 || got[0] != 0 || got[1] != 950 || got[2] != 1900 {
		t.Fatalf("overview 2000ms timestamps = %v, want [0 950 1900]", got)
	}
	inspect := frameSampleTimestamps(250, 1750, 4)
	if len(inspect) != 4 || inspect[0] != 250 || inspect[3] != 1650 || !(inspect[0] < inspect[1] && inspect[1] < inspect[2] && inspect[2] < inspect[3]) {
		t.Fatalf("inspect timestamps = %v", inspect)
	}
	short := frameSampleTimestamps(0, 80, 3)
	if len(short) != 3 || short[0] != 0 || short[2] < 0 || short[2] > 80 || short[1] > short[2] {
		t.Fatalf("short <=100ms timestamps = %v", short)
	}
	tiny := frameSampleTimestamps(0, 1, 3)
	for _, ts := range tiny {
		if ts < 0 || ts > 1 {
			t.Fatalf("tiny clip timestamp out of range: %v", tiny)
		}
	}
}

func makeFFmpegVideoFixture(t *testing.T, extraArgs ...string) []byte {
	t.Helper()
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable")
	}
	path := filepath.Join(t.TempDir(), "fixture.mp4")
	args := append([]string{"-nostdin", "-v", "error"}, extraArgs...)
	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path)
	if out, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg fixture failed: %v %s", err, out)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestMediaFrameExtractionHDScale1024AndFirstMidTailTimestamps(t *testing.T) {
	// 1920x1080 2s video: must scale down to long edge 1024 (1024x576) and sample t=0, mid, tail.
	data := makeFFmpegVideoFixture(t,
		"-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=24:d=2",
		"-t", "2",
	)
	d := &mediaDomain{owner: "owner", data: data}
	overview, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
	if err != nil {
		t.Fatalf("overview failed: %v", err)
	}
	if len(overview.Content) != 3 {
		t.Fatalf("overview frames = %d, want 3", len(overview.Content))
	}
	if overview.Content[0].Source.StartMs != 0 {
		t.Fatalf("first frame StartMs = %d, want 0", overview.Content[0].Source.StartMs)
	}
	if overview.Content[1].Source.StartMs <= 0 || overview.Content[1].Source.StartMs >= overview.Content[2].Source.StartMs {
		t.Fatalf("midpoint frame StartMs not between first and tail: %d, %d, %d",
			overview.Content[0].Source.StartMs, overview.Content[1].Source.StartMs, overview.Content[2].Source.StartMs)
	}
	if overview.Content[2].Source.StartMs < overview.DurationMs-250 || overview.Content[2].Source.StartMs > overview.DurationMs {
		t.Fatalf("tail frame StartMs = %d, duration = %d", overview.Content[2].Source.StartMs, overview.DurationMs)
	}
	for i, part := range overview.Content {
		raw, err := base64.StdEncoding.DecodeString(part.Data)
		if err != nil {
			t.Fatalf("frame %d base64 decode: %v", i, err)
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
		if err != nil || format != "jpeg" {
			t.Fatalf("frame %d invalid jpeg: format=%q err=%v", i, format, err)
		}
		longEdge := max(cfg.Width, cfg.Height)
		if longEdge != 1024 || cfg.Width != 1024 || cfg.Height != 576 {
			t.Fatalf("frame %d dimensions = %dx%d, want 1024x576", i, cfg.Width, cfg.Height)
		}
		if part.Source.TimestampKind != "requested_seek" {
			t.Fatalf("frame %d TimestampKind = %q", i, part.Source.TimestampKind)
		}
	}

	inspect, err := mediaTestCall(t, d, "media.inspect", mediaArgs{
		CanvasID:        "canvas",
		NodeID:          "node",
		ExpectedVersion: overview.Source.Version,
		StartMs:         200,
		EndMs:           1800,
		Mode:            "frames",
	})
	if err != nil {
		t.Fatalf("inspect frames failed: %v", err)
	}
	if len(inspect.Content) != 4 || inspect.Content[0].Source.StartMs != 200 || inspect.Content[3].Source.StartMs != 1700 {
		t.Fatalf("inspect frames timestamps unexpected: len=%d first=%d last=%d",
			len(inspect.Content), inspect.Content[0].Source.StartMs, inspect.Content[len(inspect.Content)-1].Source.StartMs)
	}
}

func TestMediaFrameExtractionShortClipAndVFRTailFallback(t *testing.T) {
	t.Run("short-clip-under-100ms", func(t *testing.T) {
		data := makeFFmpegVideoFixture(t,
			"-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=0.08",
			"-t", "0.08",
		)
		d := &mediaDomain{owner: "owner", data: data}
		overview, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
		if err != nil {
			t.Fatalf("short clip overview failed: %v", err)
		}
		if overview.DurationMs <= 0 || overview.DurationMs > 150 {
			t.Fatalf("expected very short clip duration, got %dms", overview.DurationMs)
		}
		if len(overview.Content) != 3 {
			t.Fatalf("short clip frames = %d, want 3", len(overview.Content))
		}
		for i, part := range overview.Content {
			if part.Source.StartMs < 0 || part.Source.StartMs > overview.DurationMs {
				t.Fatalf("frame %d timestamp %d outside [0,%d]", i, part.Source.StartMs, overview.DurationMs)
			}
			raw, err := base64.StdEncoding.DecodeString(part.Data)
			if err != nil || len(raw) == 0 {
				t.Fatalf("frame %d empty jpeg", i)
			}
		}
	})

	t.Run("vfr-sparse-tail-fallback", func(t *testing.T) {
		// Create a VFR video whose video frames stop earlier than the container/audio duration
		// (video 1.0s + audio 2.5s): seeking to tail ~2.4s produces 0 video frames on primary seek,
		// so the fallback chain (-sseof / 0.9*span / first-frame) MUST recover instead of failing.
		bin, err := exec.LookPath("ffmpeg")
		if err != nil {
			t.Skip("ffmpeg unavailable")
		}
		if _, err := exec.LookPath("ffprobe"); err != nil {
			t.Skip("ffprobe unavailable")
		}
		dir := t.TempDir()
		outPath := filepath.Join(dir, "vfr-tail-gap.mp4")
		cmd := exec.Command(bin,
			"-nostdin", "-v", "error",
			"-f", "lavfi", "-i", "testsrc2=s=640x360:r=2:d=1",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=2.5",
			"-fps_mode", "vfr",
			"-c:v", "libx264", "-pix_fmt", "yuv420p",
			"-c:a", "aac",
			"-y", outPath,
		)
		if raw, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("vfr fixture failed: %v %s", err, raw)
		}
		data, err := os.ReadFile(outPath)
		if err != nil {
			t.Fatal(err)
		}
		d := &mediaDomain{owner: "owner", data: data}
		overview, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
		if err != nil {
			t.Fatalf("VFR tail-gap overview must recover via fallback, got err: %v", err)
		}
		if len(overview.Content) != 3 {
			t.Fatalf("VFR overview frames = %d, want 3", len(overview.Content))
		}
		for i, part := range overview.Content {
			raw, err := base64.StdEncoding.DecodeString(part.Data)
			if err != nil {
				t.Fatalf("frame %d decode err: %v", i, err)
			}
			if _, format, err := image.DecodeConfig(bytes.NewReader(raw)); err != nil || format != "jpeg" {
				t.Fatalf("frame %d invalid jpeg: %q %v", i, format, err)
			}
		}
	})
}

func TestMediaFrameExtractionDynamicBudgetDownscale(t *testing.T) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable")
	}
	// High-entropy noise at 1920x1080 creates large JPEGs at 1024 -q:v 3; a tight budget triggers tier downscale.
	data := makeFFmpegVideoFixture(t,
		"-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=24:d=1",
		"-t", "1",
	)
	dir := t.TempDir()
	input := filepath.Join(dir, "source.mp4")
	if err := os.WriteFile(input, data, 0o600); err != nil {
		t.Fatal(err)
	}
	facts, err := probeMediaFacts(context.Background(), input, false)
	if err != nil {
		t.Fatal(err)
	}
	p := preparedMedia{
		input:     input,
		directory: dir,
		source:    MediaSource{CanvasID: "canvas", NodeID: "node", ResourceID: "resource", Version: "v1"},
		facts:     facts,
	}
	// Measure default 1024 size first, then set a budget smaller than 3x full-size frame so downscaling must activate.
	full, err := p.extractVideoFrames(context.Background(), bin, "media.overview", mediaArgs{StartMs: 0, EndMs: facts.DurationMs}, MediaResult{Source: p.source}, maxMediaPartBytes)
	if err != nil || len(full.Content) != 3 {
		t.Fatalf("full extract failed: %v", err)
	}
	firstFullRaw, _ := base64.StdEncoding.DecodeString(full.Content[0].Data)
	tightBudget := int64(len(firstFullRaw))*2 + 1024 // forces 1024 frame to exceed perFrameSoftCap
	scaled, err := p.extractVideoFrames(context.Background(), bin, "media.overview", mediaArgs{StartMs: 0, EndMs: facts.DurationMs}, MediaResult{Source: p.source}, tightBudget)
	if err != nil {
		t.Fatalf("tight budget should dynamically scale down instead of failing: %v", err)
	}
	if len(scaled.Content) != 3 {
		t.Fatalf("scaled frames = %d, want 3", len(scaled.Content))
	}
	scaledRaw, _ := base64.StdEncoding.DecodeString(scaled.Content[0].Data)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(scaledRaw))
	if err != nil {
		t.Fatal(err)
	}
	if max(cfg.Width, cfg.Height) >= 1024 {
		t.Fatalf("expected downscaled edge < 1024 under tight budget, got %dx%d", cfg.Width, cfg.Height)
	}
}
