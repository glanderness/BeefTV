package mediatools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const defaultPosterTimeout = 15 * time.Second

// ExtractVideoPoster decodes a single display-sized JPEG poster frame from a
// local video file using ffmpeg and publishes it atomically to dstPath.
func ExtractVideoPoster(ctx context.Context, srcPath string, dstPath string, maxSide int) error {
	if err := ensureRegularFile(srcPath); err != nil {
		return err
	}
	if maxSide <= 0 {
		maxSide = 1024
	}
	ffmpegBin, err := ResolveFFmpeg()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dstPath), 0o750); err != nil {
		return fmt.Errorf("%w：创建封面目录失败", ErrMediaProcessFailed)
	}
	runCtx := ctx
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, defaultPosterTimeout)
		defer cancel()
	}

	tmp, err := os.CreateTemp(filepath.Dir(dstPath), ".poster-*.jpg")
	if err != nil {
		return fmt.Errorf("%w：创建临时封面文件失败", ErrMediaProcessFailed)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	scaleFilter := fmt.Sprintf(
		"scale=w='if(gt(iw,ih),min(%d,iw),-2)':h='if(gt(iw,ih),-2,min(%d,ih))':force_original_aspect_ratio=decrease",
		maxSide, maxSide,
	)

	// Capture frame 0 first so AI first-frame videos preserve their opening composition.
	// Only probe a slight offset (0.2s) when frame 0 fails or is nearly pure black (fade-in).
	chosenPath := tmpPath
	if err := runPosterFFmpeg(runCtx, ffmpegBin, srcPath, tmpPath, scaleFilter, false); err != nil {
		if runCtx.Err() != nil {
			return runCtx.Err()
		}
		if fallbackErr := runPosterFFmpeg(runCtx, ffmpegBin, srcPath, tmpPath, scaleFilter, true); fallbackErr != nil {
			return fallbackErr
		}
	} else if isMostlyBlackJPEG(tmpPath) {
		if alt, altErr := os.CreateTemp(filepath.Dir(dstPath), ".poster-alt-*.jpg"); altErr == nil {
			altPath := alt.Name()
			_ = alt.Close()
			defer os.Remove(altPath)
			if runCtx.Err() == nil && runPosterFFmpeg(runCtx, ffmpegBin, srcPath, altPath, scaleFilter, true) == nil {
				chosenPath = altPath
			}
		}
	}
	info, statErr := os.Stat(chosenPath)
	if statErr != nil || info.Size() == 0 {
		return fmt.Errorf("%w：视频封面为空", ErrInvalidMedia)
	}
	_ = os.Chmod(chosenPath, 0o640)
	if err := os.Rename(chosenPath, dstPath); err != nil {
		return fmt.Errorf("%w：发布视频封面失败", ErrMediaProcessFailed)
	}
	return nil
}

func runPosterFFmpeg(ctx context.Context, ffmpegBin, srcPath, dstPath, scaleFilter string, seekOffset bool) error {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}
	if seekOffset {
		args = append(args, "-ss", "0.2")
	}
	args = append(args,
		"-i", srcPath,
		"-an", "-sn", "-dn",
		"-frames:v", "1",
		"-vf", scaleFilter,
		"-c:v", "mjpeg",
		"-q:v", "4",
		"-f", "image2",
		"-update", "1",
		dstPath,
	)
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	HideConsole(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, exec.ErrNotFound) {
			return ErrToolUnavailable
		}
		return fmt.Errorf("%w：%s", ErrMediaProcessFailed, RedactDiagnosticText(stderr.String()))
	}
	info, err := os.Stat(dstPath)
	if err != nil || info.Size() == 0 {
		return fmt.Errorf("%w：未输出封面帧", ErrMediaProcessFailed)
	}
	return nil
}

// isMostlyBlackJPEG samples an 8x8 grid across a decoded JPEG poster and reports
// whether the frame is effectively pure black (average luminance < 6, max < 16),
// matching the frontend video poster black-frame check.
func isMostlyBlackJPEG(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	img, err := jpeg.Decode(file)
	if err != nil {
		return false
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w <= 0 || h <= 0 {
		return false
	}
	cols := min(8, w)
	rows := min(8, h)
	var lumSum, maxLum float64
	samples := 0
	for r := 0; r < rows; r++ {
		y := bounds.Min.Y + min(h-1, int((float64(r)+0.5)*float64(h)/float64(rows)))
		for c := 0; c < cols; c++ {
			x := bounds.Min.X + min(w-1, int((float64(c)+0.5)*float64(w)/float64(cols)))
			red, green, blue, _ := img.At(x, y).RGBA()
			lum := 0.299*float64(red>>8) + 0.587*float64(green>>8) + 0.114*float64(blue>>8)
			lumSum += lum
			if lum > maxLum {
				maxLum = lum
			}
			samples++
		}
	}
	return samples > 0 && lumSum/float64(samples) < 6 && maxLum < 16
}

// ScaleImagePreview scales an oversized local image into a display-sized JPEG
// or PNG preview inside an OS-isolated ffmpeg subprocess so the Go host never
// allocates multi-hundred-megabyte RGBA buffers for huge source images.
func ScaleImagePreview(ctx context.Context, srcPath string, dstPath string, maxSide int, orientation int, outputPNG bool) error {
	if err := ensureRegularFile(srcPath); err != nil {
		return err
	}
	if maxSide <= 0 {
		maxSide = 1024
	}
	ffmpegBin, err := ResolveFFmpeg()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dstPath), 0o750); err != nil {
		return fmt.Errorf("%w：创建预览目录失败", ErrMediaProcessFailed)
	}
	runCtx := ctx
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, defaultPosterTimeout)
		defer cancel()
	}

	ext := ".jpg"
	if outputPNG {
		ext = ".png"
	}
	tmp, err := os.CreateTemp(filepath.Dir(dstPath), ".imgprev-*"+ext)
	if err != nil {
		return fmt.Errorf("%w：创建临时预览文件失败", ErrMediaProcessFailed)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	// Scale before EXIF transpose so the filter works on a small frame.
	vf := fmt.Sprintf(
		"scale=w='if(gt(iw,ih),min(%d,iw),-1)':h='if(gt(iw,ih),-1,min(%d,ih))':force_original_aspect_ratio=decrease",
		maxSide, maxSide,
	)
	if orientFilter := exifOrientationFFmpegFilter(orientation); orientFilter != "" {
		vf = vf + "," + orientFilter
	}

	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-max_pixels", "268435456",
		"-threads", "2",
		"-noautorotate",
		"-i", srcPath,
		"-an", "-sn", "-dn",
		"-frames:v", "1",
		"-vf", vf,
	}
	if outputPNG {
		args = append(args, "-c:v", "png", "-compression_level", "2", "-f", "image2", "-update", "1", tmpPath)
	} else {
		args = append(args, "-c:v", "mjpeg", "-q:v", "4", "-f", "image2", "-update", "1", tmpPath)
	}

	cmd := exec.CommandContext(runCtx, ffmpegBin, args...)
	HideConsole(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if runCtx.Err() != nil {
			return runCtx.Err()
		}
		if errors.Is(err, exec.ErrNotFound) {
			return ErrToolUnavailable
		}
		return fmt.Errorf("%w：%s", ErrMediaProcessFailed, RedactDiagnosticText(stderr.String()))
	}
	info, statErr := os.Stat(tmpPath)
	if statErr != nil || info.Size() == 0 {
		return fmt.Errorf("%w：图片预览生成结果为空", ErrInvalidMedia)
	}
	_ = os.Chmod(tmpPath, 0o640)
	if err := os.Rename(tmpPath, dstPath); err != nil {
		return fmt.Errorf("%w：发布图片预览失败", ErrMediaProcessFailed)
	}
	return nil
}

func exifOrientationFFmpegFilter(orientation int) string {
	switch orientation {
	case 2:
		return "hflip"
	case 3:
		return "hflip,vflip"
	case 4:
		return "vflip"
	case 5:
		return "transpose=0"
	case 6:
		return "transpose=1"
	case 7:
		return "transpose=3"
	case 8:
		return "transpose=2"
	default:
		return ""
	}
}
