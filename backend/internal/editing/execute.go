package editing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/mediatools"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

const (
	renderOutputName     = "render-output.mp4"
	ffmpegLogTailMax     = 64 << 10
	ffmpegErrorTailBytes = 400
)

// Renderer executes a compiled semantic plan with native ffmpeg.
// It materializes opaque sources, probes tracks, lowers the plan, and writes
// one bounded MP4. It does not compile a second plan or persist workspace resources.
type Renderer struct {
	Sources SourceOpener
	FFmpeg  string
}

// RenderedOutput is the local encode result before workspace resource composition.
type RenderedOutput struct {
	Path        string
	Size        int64
	Width       int
	Height      int
	DurationMs  int64
	SubtitleSRT string
}

func (r *Renderer) ffmpegBinary() (string, error) {
	if r != nil && strings.TrimSpace(r.FFmpeg) != "" {
		return r.FFmpeg, nil
	}
	return ResolveFFmpegBinary()
}

func reportProgress(progress Progress, stage string, percent int) error {
	if progress == nil {
		return nil
	}
	return progress(stage, percent)
}

// Render materializes sources, binds probe facts, and encodes the plan.
// On success the caller must invoke cleanup after consuming Path.
// On failure cleanup has already run.
func (r *Renderer) Render(ctx context.Context, plan *Plan, progress Progress) (RenderedOutput, func(), error) {
	if plan == nil || !plan.HasMedia() {
		return RenderedOutput{}, nil, ErrNoMedia
	}
	ffmpegBin, err := r.ffmpegBinary()
	if err != nil {
		return RenderedOutput{}, nil, err
	}
	if err := reportProgress(progress, "准备媒体…", 10); err != nil {
		return RenderedOutput{}, nil, err
	}
	workDir, files, cleanup, err := r.materialize(ctx, plan)
	if err != nil {
		return RenderedOutput{}, nil, err
	}
	fail := func(err error) (RenderedOutput, func(), error) {
		if cleanup != nil {
			cleanup()
		}
		return RenderedOutput{}, nil, err
	}
	facts := map[string]SourceFacts{}
	for sourceID, path := range files {
		fact, probeErr := Probe(ctx, path)
		if probeErr != nil {
			return fail(probeErr)
		}
		facts[sourceID] = fact
	}
	if err := ApplySourceFacts(plan, facts); err != nil {
		return fail(err)
	}
	if plan.SubtitleSRT != "" {
		if err := os.WriteFile(filepath.Join(workDir, SubtitleFileName), []byte(plan.SubtitleSRT), 0600); err != nil {
			return fail(fmt.Errorf("写入字幕文件失败"))
		}
	}
	hasFilterListing := mediatools.SupportsFFmpegFilter(ffmpegBin, "null")
	if hasFilterListing && !mediatools.SupportsH264Encode(ffmpegBin) {
		return fail(fmt.Errorf("本机媒体编码器缺少 H.264 视频编码支持"))
	}
	encodeOpts := EncodeOptions{
		VideoCodecArgs:    mediatools.PreferredH264VideoArgs(ffmpegBin, "veryfast", "23", "6M", "10M"),
		ProtocolWhitelist: "file,pipe",
	}
	if plan.Output.BurnSubtitles && plan.SubtitleSRT != "" && hasFilterListing && !mediatools.SupportsFFmpegFilter(ffmpegBin, "subtitles") {
		overlays, overlayErr := RasterizeSubtitleOverlays(workDir, *plan)
		if overlayErr != nil {
			return fail(overlayErr)
		}
		encodeOpts.SubtitleOverlays = overlays
	}
	target := filepath.Join(workDir, renderOutputName)
	args := BuildFFmpegArgs(*plan, files, target, encodeOpts)
	if len(args) == 0 {
		return fail(fmt.Errorf("无法生成渲染命令"))
	}
	if err := reportProgress(progress, "正在渲染…", 30); err != nil {
		return fail(err)
	}
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	mediatools.HideConsole(cmd)
	cmd.Dir = workDir
	log := &ffmpegLogTail{max: ffmpegLogTailMax}
	cmd.Stdout = log
	cmd.Stderr = log
	runErr := cmd.Run()
	output := log.Text()
	if runErr != nil || (plan.SubtitleSRT != "" && log.FontFailure()) {
		return fail(fmt.Errorf("ffmpeg 渲染失败：%s", ffmpegErrorDetail(output, runErr)))
	}
	outputFacts, size, err := verifyRenderedOutput(ctx, target, plan)
	if err != nil {
		return fail(err)
	}
	width, height := plan.Output.Width, plan.Output.Height
	if width <= 0 {
		width = DefaultWidth
	}
	if height <= 0 {
		height = DefaultHeight
	}
	return RenderedOutput{
		Path:        target,
		Size:        size,
		Width:       width,
		Height:      height,
		DurationMs:  outputFacts.DurationMs,
		SubtitleSRT: plan.SubtitleSRT,
	}, cleanup, nil
}

func verifyRenderedOutput(ctx context.Context, path string, plan *Plan) (SourceFacts, int64, error) {
	stat, err := os.Stat(path)
	if err != nil {
		return SourceFacts{}, 0, fmt.Errorf("读取渲染产物失败")
	}
	if stat.Size() == 0 {
		return SourceFacts{}, 0, fmt.Errorf("渲染产物为空")
	}
	facts, err := Probe(ctx, path)
	if err != nil {
		return SourceFacts{}, 0, fmt.Errorf("渲染产物不是有效媒体")
	}
	if !facts.HasVideo {
		return SourceFacts{}, 0, fmt.Errorf("渲染产物缺少视频轨")
	}
	if !facts.HasAudio {
		return SourceFacts{}, 0, fmt.Errorf("渲染产物缺少音频轨")
	}
	if facts.DurationMs <= 0 {
		return SourceFacts{}, 0, fmt.Errorf("渲染产物时长无效")
	}
	if plan != nil && !outputDurationWithinPlan(plan.DurationMs, facts.DurationMs, plan.Output.FPS) {
		return SourceFacts{}, 0, fmt.Errorf("渲染产物时长无效")
	}
	return facts, stat.Size(), nil
}

func outputDurationWithinPlan(planMs, probedMs int64, fps int) bool {
	if planMs <= 0 || probedMs <= 0 {
		return false
	}
	delta := planMs - probedMs
	if delta < 0 {
		delta = -delta
	}
	if fps <= 0 {
		fps = DefaultFPS
	}
	// A legal low-frame-rate encode is quantized to complete video frames.
	// Keep the normal bound, allowing at most one frame plus container slack.
	tolerance := max(int64(OutputDurationToleranceMs), (1000+int64(fps)-1)/int64(fps)+100)
	return delta <= tolerance
}

func ffmpegErrorDetail(output string, runErr error) string {
	detail := strings.TrimSpace(output)
	if len(detail) > ffmpegErrorTailBytes {
		detail = detail[len(detail)-ffmpegErrorTailBytes:]
	}
	if detail != "" {
		return detail
	}
	if runErr != nil {
		return runErr.Error()
	}
	return "unknown encoder error"
}

type ffmpegLogTail struct {
	mu          sync.Mutex
	max         int
	buf         []byte
	fontFailure bool
	scanTail    string
}

func (t *ffmpegLogTail) Write(p []byte) (int, error) {
	if t == nil {
		return len(p), nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	// Font warnings may occur early, before a long encode fills the diagnostic
	// tail. Retain the verdict and a small overlap for split stderr writes.
	scan := t.scanTail + string(p)
	t.fontFailure = t.fontFailure || SubtitleFontFailure(scan)
	if len(scan) > 256 {
		scan = scan[len(scan)-256:]
	}
	t.scanTail = scan
	if t.max <= 0 {
		return len(p), nil
	}
	if len(p) >= t.max {
		t.buf = append(t.buf[:0], p[len(p)-t.max:]...)
		return len(p), nil
	}
	overflow := len(t.buf) + len(p) - t.max
	if overflow > 0 {
		if overflow >= len(t.buf) {
			t.buf = t.buf[:0]
		} else {
			t.buf = t.buf[overflow:]
		}
	}
	t.buf = append(t.buf, p...)
	return len(p), nil
}

func (t *ffmpegLogTail) Text() string {
	if t == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

func (t *ffmpegLogTail) FontFailure() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.fontFailure
}

func (r *Renderer) openSource(ctx context.Context, sourceID string) (io.ReadCloser, string, error) {
	if provider, ok := r.Sources.(SourceMIMEProvider); ok {
		return provider.OpenWithMIME(ctx, sourceID)
	}
	reader, err := r.Sources.Open(ctx, sourceID)
	return reader, "", err
}

func (r *Renderer) materialize(ctx context.Context, plan *Plan) (string, map[string]string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "beeftv-render-*")
	if err != nil {
		return "", nil, nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	sourceKinds := planSourceKinds(plan)
	files := map[string]string{}
	for _, sourceID := range plan.SourceIDs() {
		if err := ctx.Err(); err != nil {
			cleanup()
			return "", nil, nil, err
		}
		if sourceID == "" {
			cleanup()
			return "", nil, nil, fmt.Errorf("片段缺少有效媒体引用")
		}
		if r == nil || r.Sources == nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		reader, mimeType, err := r.openSource(ctx, sourceID)
		if err != nil || reader == nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		var body io.Reader = reader
		ext := extensionForMIME(mimeType)
		if ext == "" {
			var headBuf [512]byte
			n, readErr := io.ReadFull(reader, headBuf[:])
			if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
				reader.Close()
				cleanup()
				return "", nil, nil, fmt.Errorf("读取时间线媒体失败: %w", readErr)
			}
			head := headBuf[:n]
			ext = materializedSourceExtension(mimeType, head, sourceKinds[sourceID])
			body = io.MultiReader(bytes.NewReader(head), reader)
		}
		path := filepath.Join(tmpDir, fmt.Sprintf("src-%d%s", len(files), ext))
		file, err := os.Create(path)
		if err != nil {
			reader.Close()
			cleanup()
			return "", nil, nil, fmt.Errorf("写入临时媒体失败: %w", err)
		}
		if _, err := io.Copy(file, body); err != nil {
			file.Close()
			reader.Close()
			cleanup()
			return "", nil, nil, fmt.Errorf("读取时间线媒体失败: %w", err)
		}
		if err := file.Close(); err != nil {
			reader.Close()
			cleanup()
			return "", nil, nil, fmt.Errorf("写入临时媒体失败: %w", err)
		}
		if err := reader.Close(); err != nil {
			cleanup()
			return "", nil, nil, fmt.Errorf("读取时间线媒体失败: %w", err)
		}
		files[sourceID] = path
	}
	return tmpDir, files, cleanup, nil
}

func planSourceKinds(plan *Plan) map[string]string {
	kinds := map[string]string{}
	if plan == nil {
		return kinds
	}
	for _, seg := range plan.Segments {
		if seg.Kind != KindGap && seg.SourceID != "" {
			kinds[seg.SourceID] = seg.Kind
		}
	}
	for _, clip := range plan.Audio {
		if clip.SourceID != "" && kinds[clip.SourceID] == "" {
			kinds[clip.SourceID] = KindAudio
		}
	}
	return kinds
}

func materializedSourceExtension(mimeType string, head []byte, planKind string) string {
	if ext := extensionForMIME(mimeType); ext != "" {
		return ext
	}
	if ext := sniffMediaExtension(head, planKind); ext != "" {
		return ext
	}
	if len(head) > 0 {
		if ext := extensionForMIME(http.DetectContentType(head)); ext != "" {
			return ext
		}
	}
	if planKind == KindVideo {
		return ".mp4"
	}
	return ".bin"
}

func extensionForMIME(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	mediaType, _, err := mime.ParseMediaType(trimmed)
	if err != nil {
		mediaType = strings.ToLower(strings.TrimSpace(strings.SplitN(trimmed, ";", 2)[0]))
	} else {
		mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	}
	switch mediaType {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime":
		return ".mov"
	case "video/x-m4v", "video/m4v":
		return ".m4v"
	case "video/webm":
		return ".webm"
	case "video/x-matroska", "video/matroska":
		return ".mkv"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave":
		return ".wav"
	case "audio/mp4", "audio/x-m4a", "audio/m4a":
		return ".m4a"
	case "audio/aac", "audio/x-aac":
		return ".aac"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/ogg", "application/ogg":
		return ".ogg"
	case "audio/opus":
		return ".opus"
	default:
		return ""
	}
}

func sniffMediaExtension(head []byte, planKind string) string {
	if len(head) == 0 {
		return ""
	}
	if len(head) >= 8 && bytes.Equal(head[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return ".png"
	}
	if len(head) >= 3 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff {
		return ".jpg"
	}
	if len(head) >= 6 && (bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a"))) {
		return ".gif"
	}
	if len(head) >= 12 && bytes.Equal(head[:4], []byte("RIFF")) {
		if bytes.Equal(head[8:12], []byte("WEBP")) {
			return ".webp"
		}
		if bytes.Equal(head[8:12], []byte("WAVE")) {
			return ".wav"
		}
	}
	if len(head) >= 4 && bytes.Equal(head[:4], []byte("fLaC")) {
		return ".flac"
	}
	if len(head) >= 4 && bytes.Equal(head[:4], []byte("OggS")) {
		if bytes.Contains(head, []byte("OpusHead")) {
			return ".opus"
		}
		return ".ogg"
	}
	if len(head) >= 4 && bytes.Equal(head[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		if bytes.Contains(bytes.ToLower(head), []byte("webm")) {
			return ".webm"
		}
		return ".mkv"
	}
	if len(head) >= 12 && bytes.Equal(head[4:8], []byte("ftyp")) {
		switch string(head[8:12]) {
		case "M4A ", "M4B ":
			return ".m4a"
		case "qt  ":
			return ".mov"
		case "M4V ":
			return ".m4v"
		default:
			if planKind == KindAudio {
				return ".m4a"
			}
			return ".mp4"
		}
	}
	if len(head) >= 3 && bytes.Equal(head[:3], []byte("ID3")) {
		return ".mp3"
	}
	if len(head) >= 2 && head[0] == 0xff && (head[1]&0xe0) == 0xe0 {
		if (head[1] & 0xf6) == 0xf0 {
			return ".aac"
		}
		return ".mp3"
	}
	return ""
}
