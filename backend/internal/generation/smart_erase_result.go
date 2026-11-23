package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beeftv"
)

func RecoverSubtitleEraseResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	return QuerySubtitleEraseResult(ctx, input, id)
}

func QuerySubtitleEraseStatus(ctx context.Context, config Config, id string) (string, error) {
	ctx = WithRequestKind(ctx, "poll")
	task, err := managedMediaClient(ctx, config).QuerySubtitleErase(ctx, id, config.Model)
	return task.Status, legacyMediaError(err)
}

func QuerySubtitleEraseResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	queryCtx := WithRequestKind(ctx, "poll")
	client := managedMediaClient(queryCtx, input.Config)
	receipt, err := client.QuerySubtitleErase(queryCtx, id, input.Config.Model)
	status := receipt.Status
	if err != nil {
		return nil, "", legacyMediaError(err)
	}
	label := resolveSmartEraseSpec(input.SubtitleErase, input.Config.Model).Prompt
	switch status {
	case "queued", "in_progress", "cancelling", "unknown":
		return nil, status, nil
	case "failed", "cancelled":
		if receipt.Error != nil && strings.TrimSpace(receipt.Error.UserMessage) != "" {
			return nil, status, errors.New(strings.TrimSpace(receipt.Error.UserMessage))
		}
		if receipt.Error != nil && strings.TrimSpace(receipt.Error.Message) != "" {
			return nil, status, errors.New(strings.TrimSpace(receipt.Error.Message))
		}
		return nil, status, fmt.Errorf("%s未完成，请查看任务详情", label)
	case "completed":
	default:
		return nil, status, StatePendingError{TaskID: id, Cause: fmt.Errorf("unknown subtitle erase status")}
	}
	dlCtx := WithRequestKind(ctx, "download")
	out, err := downloadAndFinalizeLegacyToolVideo(dlCtx, input, id, label, func(attemptCtx context.Context, destDir string, limit int64) (string, string, error) {
		path, mime, _, dlErr := managedMediaClient(attemptCtx, input.Config).SubtitleEraseContentToFile(attemptCtx, id, destDir, limit)
		return path, mime, dlErr
	}, RestoreSubtitleEraseSourceAudioFile)
	if err != nil {
		var persistErr VideoPersistError
		if errors.As(err, &persistErr) {
			return nil, status, err
		}
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	attachSmartEraseSubtitles(ctx, client, input, id, out)
	return out, status, nil
}

// attachSmartEraseSubtitles unifies OCR/translated subtitle resolution across
// both managed (/v1/media/tasks) and legacy (/video-subtitle-erase/tasks) paths.
// When managed metadata already carries subtitles, it normalizes the payload;
// when absent and a provider task ID is known, it falls back to /subtitles.
func attachSmartEraseSubtitles(ctx context.Context, client *beeftv.MediaClient, input Input, providerTaskID string, result map[string]any) {
	if result == nil || input.SubtitleErase == nil || (!input.SubtitleErase.OCRExtract && !input.SubtitleErase.Translate) {
		return
	}
	if normalized, ok := extractNormalizedSubtitlesFromResult(result); ok {
		setResultSubtitlesMetadata(result, normalized)
		return
	}
	if client == nil || strings.TrimSpace(providerTaskID) == "" {
		return
	}
	subCtx, cancel := context.WithTimeout(WithRequestKind(ctx, "poll"), 10*time.Second)
	subs, err := client.GetSubtitleEraseSubtitles(subCtx, strings.TrimSpace(providerTaskID))
	cancel()
	if err != nil || (strings.TrimSpace(subs.OriginText) == "" && strings.TrimSpace(subs.TranslatedText) == "") {
		return
	}
	subMap := map[string]string{"format": defaultString(subs.Format, "srt")}
	if subs.OriginText != "" {
		subMap["origin_text"] = subs.OriginText
	}
	if subs.TranslatedText != "" {
		subMap["translated_text"] = subs.TranslatedText
	}
	if subs.TargetLang != "" {
		subMap["target_lang"] = subs.TargetLang
	}
	setResultSubtitlesMetadata(result, subMap)
}

func extractNormalizedSubtitlesFromResult(result map[string]any) (map[string]string, bool) {
	meta, ok := result["metadata"].(map[string]any)
	if !ok || meta == nil {
		return nil, false
	}
	raw, exists := meta["subtitles"]
	if !exists || raw == nil {
		return nil, false
	}
	if existing, ok := raw.(map[string]string); ok {
		if strings.TrimSpace(existing["origin_text"]) == "" && strings.TrimSpace(existing["translated_text"]) == "" {
			return nil, false
		}
		if strings.TrimSpace(existing["format"]) == "" {
			existing["format"] = "srt"
		}
		return existing, true
	}
	var decoded struct {
		Format         string `json:"format"`
		OriginText     string `json:"origin_text"`
		TranslatedText string `json:"translated_text"`
		TargetLang     string `json:"target_lang"`
	}
	rawBytes, err := json.Marshal(raw)
	if err != nil || json.Unmarshal(rawBytes, &decoded) != nil {
		return nil, false
	}
	if strings.TrimSpace(decoded.OriginText) == "" && strings.TrimSpace(decoded.TranslatedText) == "" {
		return nil, false
	}
	out := map[string]string{"format": defaultString(decoded.Format, "srt")}
	if decoded.OriginText != "" {
		out["origin_text"] = decoded.OriginText
	}
	if decoded.TranslatedText != "" {
		out["translated_text"] = decoded.TranslatedText
	}
	if decoded.TargetLang != "" {
		out["target_lang"] = decoded.TargetLang
	}
	return out, true
}

func setResultSubtitlesMetadata(result map[string]any, subMap map[string]string) {
	meta, ok := result["metadata"].(map[string]any)
	if !ok || meta == nil {
		meta = map[string]any{}
		result["metadata"] = meta
	}
	meta["subtitles"] = subMap
}

// RestoreSubtitleEraseSourceAudioFile preserves the source video's audio track
// onto outputPath entirely on disk without loading either video into memory.
func RestoreSubtitleEraseSourceAudioFile(ctx context.Context, input Input, outputPath string) (string, func(), error) {
	noop := func() {}
	if input.SubtitleErase == nil || input.Mode != "video" {
		return outputPath, noop, nil
	}
	return restoreMediaSourceAudioFile(ctx, input, outputPath)
}

func CancelSubtitleErase(ctx context.Context, config Config, id string) error {
	return managedMediaClient(ctx, config).CancelSubtitleErase(ctx, id)
}
