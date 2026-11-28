package operations

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"infinite-canvas/backend/internal/mediatools"
)

type frameQualityTier struct {
	maxEdge int
	qscale  string
}

var videoFrameTiers = []frameQualityTier{
	{maxEdge: 1024, qscale: "3"},
	{maxEdge: 768, qscale: "5"},
	{maxEdge: 640, qscale: "7"},
}

// frameSampleTimestamps picks first frame (startMs), uniform midpoints, and a
// tail frame clamped safely for short clips (span <= 100ms).
func frameSampleTimestamps(startMs, endMs int64, count int) []int64 {
	if count <= 1 {
		return []int64{startMs}
	}
	span := endMs - startMs
	if span <= 0 {
		out := make([]int64, count)
		for i := range out {
			out[i] = startMs
		}
		return out
	}
	var tailMs int64
	if span > 100 {
		tailMs = endMs - 100
	} else {
		tailMs = startMs + (span*9)/10
	}
	if tailMs < startMs {
		tailMs = startMs
	}
	if tailMs > endMs {
		tailMs = endMs
	}
	timestamps := make([]int64, count)
	timestamps[0] = startMs
	timestamps[count-1] = tailMs
	for i := 1; i < count-1; i++ {
		timestamps[i] = startMs + (tailMs-startMs)*int64(i)/int64(count-1)
	}
	return timestamps
}

func buildFrameVideoFilter(bin string, tier frameQualityTier, atMs int64, burnTimestamp bool) string {
	scale := fmt.Sprintf(
		"scale=w='min(iw,%d)':h='min(ih,%d)':force_original_aspect_ratio=decrease",
		tier.maxEdge, tier.maxEdge,
	)
	if !burnTimestamp || !mediatools.SupportsFFmpegFilter(bin, "drawtext") {
		return scale
	}
	label := fmt.Sprintf("%.2fs", float64(atMs)/1000)
	return scale + fmt.Sprintf(",drawtext=text='%s':x=12:y=12:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6", label)
}

func tryExtractFrameCommand(ctx context.Context, bin string, command []string, output string) (int64, bool) {
	_ = os.Remove(output)
	if _, err := mediaCommand(ctx, bin, command...); err != nil {
		return 0, false
	}
	stat, err := os.Stat(output)
	if err != nil || stat.Size() == 0 {
		return 0, false
	}
	return stat.Size(), true
}

// extractVideoFrameWithFallback uses fast input-side seeking (-ss before -i)
// and falls back safely on VFR / short tail frames (-sseof -0.1 when at EOF,
// 0.9*span seek, and startMs / first-frame fallback) so tail seeks never fail
// with 0-frame media_processing_failed errors.
func extractVideoFrameWithFallback(
	ctx context.Context,
	bin, input, output string,
	atMs, startMs, endMs, durationMs int64,
	isTail bool,
	tier frameQualityTier,
	burnTimestamp bool,
) (int64, int64, error) {
	vf := buildFrameVideoFilter(bin, tier, atMs, burnTimestamp)
	runAt := func(seekFlag, seekVal string, inputSide bool) (int64, bool) {
		var cmd []string
		if inputSide {
			cmd = []string{"-nostdin", "-v", "error", seekFlag, seekVal, "-i", input, "-frames:v", "1", "-vf", vf, "-q:v", tier.qscale, "-y", output}
		} else {
			cmd = []string{"-nostdin", "-v", "error", "-i", input, seekFlag, seekVal, "-frames:v", "1", "-vf", vf, "-q:v", tier.qscale, "-y", output}
		}
		return tryExtractFrameCommand(ctx, bin, cmd, output)
	}

	// Primary fast input-side seek (-ss before -i).
	if size, ok := runAt("-ss", mediaSeconds(atMs), true); ok {
		return size, atMs, nil
	}

	// Tail-frame / short-clip fallback chain for VFR or sparse trailing keyframes.
	if isTail && durationMs > 0 && endMs >= durationMs-100 {
		if size, ok := runAt("-sseof", "-0.1", true); ok {
			return size, atMs, nil
		}
	}

	span := endMs - startMs
	fallbackMs := startMs + (span*9)/10
	if fallbackMs == atMs && span > 0 {
		fallbackMs = startMs + (span*8)/10
	}
	if fallbackMs < startMs {
		fallbackMs = startMs
	}
	if fallbackMs != atMs {
		if size, ok := runAt("-ss", mediaSeconds(fallbackMs), true); ok {
			return size, fallbackMs, nil
		}
	}

	// Accurate output-side seek fallback for short or tricky VFR containers.
	if size, ok := runAt("-ss", mediaSeconds(fallbackMs), false); ok {
		return size, fallbackMs, nil
	}
	if startMs != fallbackMs {
		if size, ok := runAt("-ss", mediaSeconds(startMs), true); ok {
			return size, startMs, nil
		}
	}
	// Ultimate first-frame safety net for ultra-short (<=100ms) single-frame clips.
	if size, ok := tryExtractFrameCommand(ctx, bin, []string{"-nostdin", "-v", "error", "-i", input, "-frames:v", "1", "-vf", vf, "-q:v", tier.qscale, "-y", output}, output); ok {
		return size, startMs, nil
	}
	return 0, atMs, PreconditionFailed("media_processing_failed", "媒体处理未产生有效内容", nil)
}

func (p preparedMedia) extractVideoFrames(ctx context.Context, bin, operation string, args mediaArgs, result MediaResult, budgetBytes int64) (MediaResult, error) {
	if !p.facts.HasVideo {
		return MediaResult{}, InvalidArg("media_no_video", "这个素材没有画面")
	}
	if budgetBytes <= 0 || budgetBytes > maxMediaPartBytes {
		budgetBytes = maxMediaPartBytes
	}
	count := 4
	if operation == "media.overview" {
		count = 3
	}
	timestamps := frameSampleTimestamps(args.StartMs, args.EndMs, count)
	tierIdx := 0
	var totalBytes int64

	for i, at := range timestamps {
		output := filepath.Join(p.directory, "frame-"+strconv.Itoa(i)+".jpg")
		isTail := i == len(timestamps)-1
		remainingFrames := int64(len(timestamps) - i)
		var part MediaPart
		var extractedBytes int64
		var usedMs int64
		var lastErr error

		for t := tierIdx; t < len(videoFrameTiers); t++ {
			size, actualMs, err := extractVideoFrameWithFallback(
				ctx, bin, p.input, output,
				at, args.StartMs, args.EndMs, p.facts.DurationMs,
				isTail, videoFrameTiers[t], args.BurnTimestamp,
			)
			if err != nil {
				lastErr = err
				break
			}
			remainingBudget := budgetBytes - totalBytes
			perFrameSoftCap := remainingBudget / remainingFrames
			if totalBytes+size > budgetBytes || (size > perFrameSoftCap && t+1 < len(videoFrameTiers)) {
				tierIdx = t + 1
				lastErr = PreconditionFailed("media_part_too_large", "媒体预览过大，请缩小检查区间", nil)
				continue
			}
			loaded, partErr := mediaFilePart(output, "image", "image/jpeg", result.Source)
			if partErr != nil {
				lastErr = partErr
				break
			}
			part = loaded
			extractedBytes = int64(base64.StdEncoding.DecodedLen(len(loaded.Data)))
			usedMs = actualMs
			lastErr = nil
			break
		}
		if lastErr != nil {
			return MediaResult{}, lastErr
		}
		if totalBytes+extractedBytes > budgetBytes {
			return MediaResult{}, PreconditionFailed("media_part_too_large", "媒体预览过大，请缩小检查区间", nil)
		}
		part.Source.StartMs = usedMs
		part.Source.EndMs = usedMs
		part.Source.TimestampKind = "requested_seek"
		result.Content = append(result.Content, part)
		totalBytes += extractedBytes
	}
	return result, nil
}
