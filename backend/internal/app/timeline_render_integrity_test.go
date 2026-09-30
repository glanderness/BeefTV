package app

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRenderContracts(t *testing.T) {
	if !renderSubtitleFontFailure("fontselect: failed to find any fallback with glyph 0x4E2D") || renderSubtitleFontFailure("fontselect: using Chinese font") {
		t.Fatal("font failure detection")
	}

	for _, tc := range []struct {
		raw  string
		want float64
	}{{`{}`, 1}, {`{"volume":0}`, 0}, {`{"volume":0.25}`, 0.25}} {
		var clip renderClip
		if err := json.Unmarshal([]byte(tc.raw), &clip); err != nil || clip.Volume != tc.want {
			t.Fatalf("volume %s: %v/%v", tc.raw, clip.Volume, err)
		}
	}
	hidden := false
	p := renderProject{DurationMs: 6000, Tracks: []renderTrack{{ID: "v"}, {ID: "a", Muted: true}, {ID: "s", Visible: &hidden}}, Clips: []renderClip{renderClipFixture("v", "video", "v", 0, 6000, "resource:v"), renderClipFixture("a", "audio", "a", 1000, 2000, "resource:a"), {ID: "s", Kind: "subtitle", TrackID: "s", DurationMs: 1000, Text: "隐藏"}}}
	plan := buildRenderPlan(p)
	if len(plan.Audio) != 1 || !plan.Audio[0].Muted || plan.SubtitleSRT != "" {
		t.Fatalf("bad plan: %+v", plan)
	}
	if args := buildRenderFFmpegArgs(plan, "x.mp4"); args != nil {
		t.Fatal("missing source must fail")
	}
	p.Clips = append(p.Clips, renderClipFixture("overlap", "video", "v", 1000, 1000, "resource:v"))
	if buildRenderPlan(p).Error == nil {
		t.Fatal("overlap must fail explicitly")
	}
	missing := renderPlan{Segments: []renderSegment{{Kind: "video", Clip: renderClip{ID: "missing"}}}}
	if _, cleanup, err := materializeRenderSources(context.Background(), nil, "", &missing); err == nil {
		if cleanup != nil {
			cleanup()
		}
		t.Fatal("missing reference accepted")
	}
}

// These fixtures never use a database, network or model provider.
func TestRenderFFmpegSixSecondAudioAndChineseSubtitles(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required for media integration test")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir := t.TempDir()
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg failed: %v\n%s", err, out)
		}
		return out
	}
	run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-c:v", "libx264", "-c:a", "pcm_s16le", "source.mkv")
	for _, tone := range []struct {
		freq string
		file string
	}{{"440", "voice.wav"}, {"880", "bgm.wav"}} {
		run("-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency="+tone.freq+":duration=6", tone.file)
	}
	project := renderProject{DurationMs: 6000, Tracks: []renderTrack{{ID: "v"}, {ID: "a"}, {ID: "s"}}}
	for i := 0; i < 3; i++ {
		clip := renderClipFixture(string(rune('a'+i)), "video", "v", int64(i*2000), 2000, "resource:video")
		clip.SourceStartMs = int64(i * 2000)
		project.Clips = append(project.Clips, clip)
	}
	voice := renderClipFixture("voice", "audio", "a", 1000, 2000, "resource:voice")
	voice.SourceStartMs = 1000
	bgm := renderClipFixture("bgm", "audio", "a", 0, 6000, "resource:bgm")
	bgm.Volume = 0.2
	project.Clips = append(project.Clips, voice, bgm, renderClip{ID: "sub", Kind: "subtitle", TrackID: "s", StartMs: 1000, DurationMs: 2000, Text: "中文成片验证"})
	plan := buildRenderPlan(project)
	for i := range plan.Segments {
		plan.Segments[i].Source = &renderSource{Path: "source.mkv", HasAudio: true}
	}
	plan.Audio[0].Source = &renderSource{Path: "voice.wav", HasAudio: true}
	plan.Audio[1].Source = &renderSource{Path: "bgm.wav", HasAudio: true}
	if err := os.WriteFile(filepath.Join(dir, "render-subtitles.srt"), []byte(plan.SubtitleSRT), 0600); err != nil {
		t.Fatal(err)
	}
	log := run(buildRenderFFmpegArgs(plan, "output.mp4")...)
	if strings.Contains(string(log), "failed to find any fallback") {
		t.Fatalf("missing Chinese font: %s", log)
	}
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-")
	pcm, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	seconds := float64(len(pcm)/4) / 44100
	if math.Abs(seconds-6) > 0.06 {
		t.Fatalf("duration = %f", seconds)
	}
	amplitude := func(start float64, freq float64) float64 {
		var real, imag float64
		n := 22050
		offset := int(start * 44100)
		for i := 0; i < n; i++ {
			v := float64(math.Float32frombits(binary.LittleEndian.Uint32(pcm[(offset+i)*4:])))
			phase := 2 * math.Pi * freq * float64(i) / 44100
			real += v * math.Cos(phase)
			imag += v * math.Sin(phase)
		}
		return 2 * math.Hypot(real, imag) / float64(n)
	}
	for _, start := range []float64{0.25, 1.25, 2.25, 3.25, 5.25} {
		base, voice, bgm := amplitude(start, 220), amplitude(start, 440), amplitude(start, 880)
		t.Logf("%.2fs: 220=%.5f 440=%.5f 880=%.5f", start, base, voice, bgm)
		if base < 0.06 || bgm < 0.008 || bgm > base*0.35 {
			t.Fatal("original audio/BGM lost or wrong volume")
		}
		if start >= 1 && start < 3 {
			if voice < 0.06 {
				t.Fatal("voice missing")
			}
		} else if voice > 0.003 {
			t.Fatal("voice outside 1–3s")
		}
	}
	// Verify actual decoded silence for both zero gain and track mute.
	for i := range plan.Segments {
		plan.Segments[i].Muted = true
	}
	plan.Audio[0].Clip.Volume = 0
	plan.Audio[1].Muted = true
	run(buildRenderFFmpegArgs(plan, "muted.mp4")...)
	mutedCmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "muted.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-")
	mutedPCM, err := mutedCmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i+3 < len(mutedPCM); i += 4 {
		if math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(mutedPCM[i:])))) > 0.0001 {
			t.Fatal("muted/zero volume audio is audible")
		}
	}
	// Pixel proof of burn-in: blue frame has no bright neutral pixels; Chinese glyphs do.
	frame := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", "1.5", "-i", filepath.Join(dir, "output.mp4"), "-frames:v", "1", "-vf", "crop=1920:250:0:830", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
	pixels, err := frame.Output()
	if err != nil {
		t.Fatal(err)
	}
	white := 0
	for i := 0; i+2 < len(pixels); i += 3 {
		if pixels[i] > 180 && pixels[i+1] > 180 && pixels[i+2] > 180 {
			white++
		}
	}
	if white < 100 {
		t.Fatalf("subtitle not visible: %d white pixels", white)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.mp4"), []byte("not a video"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := probeHasAudioStream(ctx, filepath.Join(dir, "broken.mp4")); err == nil {
		t.Fatal("corrupt input silently became mute")
	}
	// Subtitle errors must fail the actual command, not produce a successful silent fallback.
	if err := os.Remove(filepath.Join(dir, "render-subtitles.srt")); err != nil {
		t.Fatal(err)
	}
	cmd = exec.CommandContext(ctx, ffmpeg, buildRenderFFmpegArgs(plan, "failed.mp4")...)
	cmd.Dir = dir
	if err := cmd.Run(); err == nil {
		t.Fatal("missing subtitle accepted")
	}
}

func TestRenderSubtitleFontFailureWithSuccessfulExit(t *testing.T) {
	for _, message := range []string{
		"can't find selected font provider", "fontselect: failed to find any fallback with glyph 0x4E2D",
		"couldn't find font family", "missing glyph 0x4E2D", "no fonts found",
	} {
		t.Run(message, func(t *testing.T) {
			// Model a libass command which reports failure only in stderr and exits zero.
			cmd := exec.Command("/bin/sh", "-c", `printf '%s\n' "$1" >&2; exit 0`, "font-fixture", message)
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("fixture must exit zero: %v", err)
			}
			if !renderSubtitleFontFailure(string(output)) {
				t.Fatalf("successful exit masked missing subtitles: %s", output)
			}
		})
	}
	for _, normal := range []string{
		"Glyph 0x4E2D not found, selecting one more font for (Arial, 400, 0)",
		"fontselect: (Arial, 400, 0) -> NotoSansCJK, 0, NotoSansCJK",
	} {
		if renderSubtitleFontFailure(normal) {
			t.Fatalf("normal fallback rejected: %s", normal)
		}
	}
}

func TestRenderFFmpegShortVideoHoldsLastFrame(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	dir := t.TempDir()
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg: %v: %s", err, out)
		}
		return out
	}
	for _, color := range []string{"red", "blue"} {
		run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c="+color+":s=320x180:r=30:d=1", "-c:v", "libx264", color+".mp4")
	}
	plan := renderPlan{Segments: []renderSegment{
		{Kind: "video", DurationMs: 2000, Clip: renderClip{DurationMs: 2000, Volume: 1}, Source: &renderSource{Path: "red.mp4"}},
		{Kind: "video", DurationMs: 1000, Clip: renderClip{DurationMs: 1000, Volume: 1}, Source: &renderSource{Path: "blue.mp4"}},
	}}
	run(buildRenderFFmpegArgs(plan, "output.mp4")...)
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-an", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
	pixels, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if len(pixels) != 90*3 {
		t.Fatalf("short source changed plan duration: %d frames", len(pixels)/3)
	}
	for i := 0; i < 90; i++ {
		r, b := pixels[i*3], pixels[i*3+2]
		if i < 60 && (r < 180 || b > 40) {
			t.Fatalf("red last frame not held at frame %d", i)
		}
		if i >= 60 && (b < 180 || r > 40) {
			t.Fatalf("blue boundary shifted at frame %d", i)
		}
	}
}
