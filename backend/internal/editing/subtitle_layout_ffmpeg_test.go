package editing

import (
	"bytes"
	"image/png"
	"infinite-canvas/backend/internal/mediatools"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPortraitSubtitleStaysInsideFrame(t *testing.T) {
	ffmpeg, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("ffmpeg required")
	}
	modes := []string{"default"}
	if runtime.GOOS == "darwin" {
		modes = append(modes, "overlay")
	}
	for _, mode := range modes {
		for _, text := range []string{"新的一天，从一口热面包开始。", "新的一天，\n从一口热面包开始。"} {
			t.Run(mode+"/"+text, func(t *testing.T) {
				if mode == "default" && !mediatools.SupportsFFmpegFilter(ffmpeg, "subtitles") {
					t.Skip("subtitles filter absent; covered by overlay subtest")
				}
				dir := t.TempDir()
				plan := Plan{
					Output:      Output{Width: 720, Height: 1280, FPS: 30, SampleRate: 48000, BurnSubtitles: true},
					DurationMs:  1000,
					Segments:    []Segment{{Kind: KindGap, DurationMs: 1000, Volume: 1}},
					SubtitleSRT: "1\n00:00:00,000 --> 00:00:01,000\n" + text + "\n",
				}
				if err := os.WriteFile(filepath.Join(dir, SubtitleFileName), []byte(plan.SubtitleSRT), 0600); err != nil {
					t.Fatal(err)
				}
				opts := EncodeOptions{
					VideoCodecArgs:    mediatools.PreferredH264VideoArgs(ffmpeg, "veryfast", "23", "6M", "10M"),
					ProtocolWhitelist: "file,pipe",
				}
				if mode == "overlay" {
					overlays, err := RasterizeSubtitleOverlays(dir, plan)
					if err != nil {
						t.Fatal(err)
					}
					opts.SubtitleOverlays = overlays
				}
				cmd := exec.Command(ffmpeg, BuildFFmpegArgs(plan, nil, "output.mp4", opts)...)
				cmd.Dir = dir
				if output, err := cmd.CombinedOutput(); err != nil || SubtitleFontFailure(string(output)) {
					t.Fatalf("render: %v %s", err, output)
				}
				frame, err := exec.Command(ffmpeg, "-v", "error", "-ss", "0.5", "-i", filepath.Join(dir, "output.mp4"), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-").Output()
				if err != nil {
					t.Fatal(err)
				}
				picture, err := png.Decode(bytes.NewReader(frame))
				if err != nil {
					t.Fatal(err)
				}
				minX, maxX, minY, maxY, pixels := 720, 0, 1280, 0, 0
				for y := 0; y < 1280; y++ {
					for x := 0; x < 720; x++ {
						r, g, b, _ := picture.At(x, y).RGBA()
						if r > 180*257 && g > 180*257 && b > 180*257 {
							minX, maxX = min(minX, x), max(maxX, x)
							minY, maxY = min(minY, y), max(maxY, y)
							pixels++
						}
					}
				}
				t.Logf("actual subtitle pixels (%s): x=%d..%d y=%d..%d count=%d", mode, minX, maxX, minY, maxY, pixels)
				if pixels < 100 || minX < 36 || maxX >= 684 || minY < 640 || maxY >= 1244 {
					t.Fatalf("subtitle is missing or outside readable margins: x=%d..%d y=%d..%d pixels=%d", minX, maxX, minY, maxY, pixels)
				}
			})
		}
	}
}
