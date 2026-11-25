package generation

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/outbound"
)

// Only local result delivery remains in generation. The adapter owns BeefTV
// routes, task envelopes and query credentials, including historical endpoints.
func QueryManagedLegacyVideo(ctx context.Context, input Input, id string) (map[string]any, string, BeefTVVideoSettlement, error) {
	return queryManagedLegacyVideoWithPolicy(ctx, input, id, videoPollPolicyForConfig(ctx, input.Config, DefaultVideoPollPolicy()))
}

func queryManagedLegacyVideoWithPolicy(ctx context.Context, input Input, id string, policy VideoPollPolicy) (map[string]any, string, BeefTVVideoSettlement, error) {
	ctx = WithRequestKind(ctx, "poll")
	client := managedMediaClient(ctx, input.Config)
	task, err := client.QueryLegacyVideo(ctx, id)
	settlement := BeefTVVideoSettlement{UsageState: task.UsageState, ReconcileDeadline: task.ReconcileDeadline}
	if err != nil {
		return nil, task.Status, settlement, legacyMediaError(err)
	}
	if err := task.Failure(); err != nil {
		return nil, task.Status, settlement, err
	}
	if !task.Done() {
		return nil, task.Status, settlement, nil
	}
	var downloadedPath string
	var mime string
	if task.URL != "" {
		link := task.URL
		downloadedPath, mime, err = RunVideoDownloadFile(ctx, id, policy, func(ctx context.Context) (string, string, error) {
			if link == "" {
				fresh, err := client.QueryLegacyVideo(WithRequestKind(ctx, "poll"), id)
				if err != nil {
					return "", "", legacyMediaError(err)
				}
				link = fresh.URL
			}
			current := link
			link = "" // A later attempt re-queries this API task, never /recover.
			if !client.AllowHTTPTest {
				ctx = outbound.WithPublicHTTPS(ctx)
			}
			filePath, mime, err := GetExternalVideoFile(context.WithValue(WithRequestKind(ctx, "download"), videoDeliveryRequestContext{}, videoDeliveryIdleTimeout), current)
			var rejected HTTPError
			if errors.As(err, &rejected) && (rejected.StatusCode == http.StatusUnauthorized || rejected.StatusCode == http.StatusForbidden) {
				err = videoBackupLinkExpiredError{cause: err}
			}
			return filePath, mime, err
		})
	} else {
		runtime, _ := RuntimeFromContext(ctx)
		destDir := ""
		if runtime.DownloadCache != nil {
			if partial := strings.TrimSpace(runtime.DownloadCache.PartialPath()); partial != "" {
				destDir = filepath.Dir(partial)
			}
		}
		limit, limitErr := GeneratedFileLimit(ctx)
		if limitErr != nil {
			return nil, task.Status, settlement, limitErr
		}
		downloadedPath, mime, err = RunVideoDownloadFile(ctx, id, policy, func(ctx context.Context) (string, string, error) {
			filePath, mime, _, dlErr := client.LegacyVideoContentToFile(ctx, task.ContentPath, destDir, limit)
			return filePath, mime, legacyMediaError(dlErr)
		})
	}
	if err != nil {
		return nil, task.Status, settlement, err
	}
	defer os.Remove(downloadedPath)

	videoMap, err := persistDownloadedVideoFile(ctx, downloadedPath, mime, "video")
	if err != nil {
		return nil, task.Status, settlement, err
	}
	attachOptionalLastFrame(ctx, videoMap, task.LastFrameURL, client.AllowHTTPTest)
	return map[string]any{"mode": "video", "video": videoMap}, task.Status, settlement, nil
}
