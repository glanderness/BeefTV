package generation

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

func getVideoResultWithGatewayFallback(ctx context.Context, config Config, rawURL, taskID string) ([]byte, string, error) {
	ctx = WithRequestKind(ctx, "download")
	downloadURL := ProviderDownloadURL(config.BaseURL, rawURL)
	u, err := url.Parse(downloadURL)
	contentURL, _ := url.Parse(APIURL(config.BaseURL, "/videos/"+taskID+"/content"))
	if err != nil || !IsBeefAPIVideoConfig(ctx, config) || !SameProviderOrigin(config.BaseURL, downloadURL) || u.Path != contentURL.Path {
		return GetProviderExternalBinary(ctx, config, rawURL)
	}
	// Keep normal media delivery for healthy routes. If the completed task's
	// media route stalls, ask the same authenticated gateway for its saved object.
	directCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	data, mime, directErr := GetProviderExternalBinary(directCtx, config, rawURL)
	cancel()
	if directErr == nil {
		return data, mime, nil
	}
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}
	if retry, _ := RetryableVideoPollError(ctx, directErr); !retry {
		return nil, "", directErr
	}
	query := u.Query()
	query.Set("delivery", "proxy")
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	ApplyAuth(req, config)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	data, mime, err = doBinaryWithoutRedirect(req)
	var httpErr HTTPError
	// Older gateways ignore the flag and redirect. Do not follow it back into
	// the slow route or turn an unsupported fallback into a generation retry.
	if errors.As(err, &httpErr) && httpErr.StatusCode >= 300 && httpErr.StatusCode < 400 {
		return nil, "", directErr
	}
	return data, mime, err
}
