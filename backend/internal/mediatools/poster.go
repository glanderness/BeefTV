package mediatools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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

	// Try a slight offset first (0.2s) to skip black lead-in frames; fall back to frame 0 for ultra-short clips.
	if err := runPosterFFmpeg(runCtx, ffmpegBin, srcPath, tmpPath, scaleFilter, true); err != nil {
		if runCtx.Err() != nil {
			return runCtx.Err()
		}
		if fallbackErr := runPosterFFmpeg(runCtx, ffmpegBin, srcPath, tmpPath, scaleFilter, false); fallbackErr != nil {
			return fallbackErr
		}
	}
	info, statErr := os.Stat(tmpPath)
	if statErr != nil || info.Size() == 0 {
		return fmt.Errorf("%w：视频封面为空", ErrInvalidMedia)
	}
	_ = os.Chmod(tmpPath, 0o640)
	if err := os.Rename(tmpPath, dstPath); err != nil {
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
		"-q:v", "4",
		"-f", "mjpeg",
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
		"-noautorotate",
		"-i", srcPath,
		"-an", "-sn", "-dn",
		"-frames:v", "1",
		"-vf", vf,
	}
	if outputPNG {
		args = append(args, "-c:v", "png", "-compression_level", "2", "-f", "image2", tmpPath)
	} else {
		args = append(args, "-q:v", "4", "-f", "mjpeg", tmpPath)
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
