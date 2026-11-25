package generation

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

const videoDeliveryIdleTimeout = 10 * time.Second

const beefTVVideoDeliveryHeader = "X-Beeftv-Video-Delivery"

// Opt in only at the trusted gateway's video status endpoint. Older clients
// keep their existing delivery route until they support same-task backup.
func applyBeefTVVideoDeliveryHeader(ctx context.Context, config Config, req *http.Request) {
	if !IsBeefTVVideoConfig(ctx, config) || req.Method != http.MethodGet || !SameProviderOrigin(config.BaseURL, req.URL.String()) {
		return
	}
	collectionURL, err := url.Parse(APIURL(config.BaseURL, "/videos"))
	if err != nil {
		return
	}
	prefix := collectionURL.Path + "/"
	if !strings.HasPrefix(req.URL.Path, prefix) {
		return
	}
	id := strings.TrimPrefix(req.URL.Path, prefix)
	if id != "" && !strings.Contains(id, "/") {
		req.Header.Set(beefTVVideoDeliveryHeader, "direct")
	}
}

type videoDeliveryRequestContext struct{}
type videoProtocolAuthContext struct{}
type videoCredentialContext struct{}

type videoProviderCredentials struct {
	Origin string
	Values []string
}

type videoResultURLResolver func(context.Context) (string, error)
type VideoResultSource struct {
	URL              string
	ReadFile         func(context.Context) (string, string, error)
	CredentialValues []string
}

func (s VideoResultSource) ready() bool {
	return strings.TrimSpace(s.URL) != "" || s.ReadFile != nil
}

type videoResultResolver func(context.Context) (VideoResultSource, error)

func withVideoProtocolAuth(ctx context.Context, auth protocol.ManifestAuth) context.Context {
	return context.WithValue(ctx, videoProtocolAuthContext{}, auth)
}

func withVideoCredentials(ctx context.Context, config Config, extra []string) context.Context {
	values := append([]string{config.APIKey, config.SecretKey}, extra...)
	if auth, ok := ctx.Value(videoProtocolAuthContext{}).(protocol.ManifestAuth); ok {
		credential := ProtocolCredentialField(config, auth.Field)
		values = append(values, credential, auth.Prefix+credential, ProtocolCredentialField(config, auth.SecretField))
	}
	for _, header := range config.Headers {
		values = append(values, header.Value)
		if strings.EqualFold(header.Name, "Cookie") {
			req := &http.Request{Header: http.Header{"Cookie": []string{header.Value}}}
			for _, cookie := range req.Cookies() {
				values = append(values, cookie.Value)
			}
		}
		if strings.EqualFold(header.Name, "Authorization") && strings.HasPrefix(strings.ToLower(header.Value), "bearer ") {
			values = append(values, strings.TrimSpace(header.Value[len("Bearer "):]))
		}
	}
	return context.WithValue(ctx, videoCredentialContext{}, videoProviderCredentials{Origin: config.BaseURL, Values: values})
}

func stripVideoCredentialQuery(target *url.URL, values []string) {
	pairs := strings.Split(target.RawQuery, "&")
	keep := make([]string, 0, len(pairs))
	changed := false
	for _, pair := range pairs {
		_, encoded, _ := strings.Cut(pair, "=")
		decoded, err := url.QueryUnescape(encoded)
		secret := false
		if err == nil {
			for _, value := range values {
				if value != "" && decoded == value {
					secret = true
					break
				}
			}
		}
		if secret {
			changed = true
		} else {
			keep = append(keep, pair)
		}
	}
	if changed {
		// Signatures may cover the original spelling and ordering of query
		// pairs. Remove only credential pairs; never re-encode the survivors.
		target.RawQuery = strings.Join(keep, "&")
	}
}

func setVideoCredentialQuery(target *url.URL, name, value string) {
	pairs := strings.Split(target.RawQuery, "&")
	if target.RawQuery == "" {
		pairs = nil
	}
	keep := make([]string, 0, len(pairs)+1)
	found, changed := false, false
	encoded := url.QueryEscape(name) + "=" + url.QueryEscape(value)
	for _, pair := range pairs {
		key, rawValue, _ := strings.Cut(pair, "=")
		decodedKey, keyErr := url.QueryUnescape(key)
		if keyErr != nil || decodedKey != name {
			keep = append(keep, pair)
			continue
		}
		if found {
			changed = true
			continue
		}
		found = true
		decodedValue, valueErr := url.QueryUnescape(rawValue)
		if valueErr == nil && decodedValue == value {
			keep = append(keep, pair)
		} else {
			keep = append(keep, encoded)
			changed = true
		}
	}
	if !found {
		keep = append(keep, encoded)
		changed = true
	}
	if changed {
		target.RawQuery = strings.Join(keep, "&")
	}
}

// videoBackupLinkExpiredError distinguishes a rejected external signed URL
// from a rejected credential at the authenticated gateway.
type videoBackupLinkExpiredError struct{ cause error }

func (e videoBackupLinkExpiredError) Error() string { return e.cause.Error() }
func (e videoBackupLinkExpiredError) Unwrap() error { return e.cause }

func videoMediaLinkRejected(ctx context.Context, config Config, rawURL string, err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) || (httpErr.StatusCode != http.StatusUnauthorized && httpErr.StatusCode != http.StatusForbidden) {
		return false
	}
	// A third-party media link may expire on its own provider origin. The
	// original task query verifies provider auth; rejection there still stops.
	return !SameProviderOrigin(config.BaseURL, ProviderDownloadURL(config.BaseURL, rawURL)) || !IsBeefTVVideoConfig(ctx, config)
}

func videoResultURL(status, rawURL string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "succeeded", "success", "done":
		if strings.TrimSpace(rawURL) == "" {
			return "", errors.New("视频任务成功但没有返回可取回的结果")
		}
		return rawURL, nil
	case "failed", "cancelled", "expired":
		return "", errors.New("原视频任务未成功，无法取回结果")
	default:
		return "", HTTPError{StatusCode: http.StatusServiceUnavailable, Body: `{"error":{"code":"video_delivery_pending"}}`}
	}
}

// videoResultFileDownloader is the single source of truth for video result
// delivery: it streams remote/protocol responses directly to disk via
// outbound.DownloadResumableToFile / StreamResponseToFile and switches to
// BeefTV backup or the original third-party task's renewed URL on transient
// failure or expired link.
func videoResultFileDownloader(config Config, taskID string, primary VideoResultSource, renew func(context.Context) (VideoResultSource, error)) func(context.Context) (string, string, error) {
	refresh := false
	readSourceFile := func(ctx context.Context, src VideoResultSource) (string, string, error) {
		dlCtx := context.WithValue(ctx, videoDeliveryRequestContext{}, videoDeliveryIdleTimeout)
		if src.ReadFile != nil {
			return src.ReadFile(dlCtx)
		}
		if strings.TrimSpace(src.URL) == "" {
			return "", "", errors.New("原视频任务没有返回可取回的结果")
		}
		return getProviderExternalVideoFile(dlCtx, config, src.URL)
	}
	readFresh := func(ctx context.Context) (string, string, error) {
		if IsBeefTVVideoConfig(ctx, config) {
			backupURL := APIURL(config.BaseURL, "/videos/"+url.PathEscape(taskID)+"/content") + "?delivery=backup"
			return getProviderExternalVideoFile(context.WithValue(ctx, videoDeliveryRequestContext{}, videoDeliveryIdleTimeout), config, backupURL)
		}
		fresh, err := renew(withDownloadObserver(ctx, nil))
		if err != nil {
			return "", "", err
		}
		ctx = withVideoCredentials(ctx, config, append(append([]string{}, primary.CredentialValues...), fresh.CredentialValues...))
		filePath, mimeType, err := readSourceFile(ctx, fresh)
		if videoMediaLinkRejected(ctx, config, fresh.URL, err) {
			err = videoBackupLinkExpiredError{cause: err}
		}
		return filePath, mimeType, err
	}
	return func(ctx context.Context) (string, string, error) {
		ctx = WithRequestKind(ctx, "download")
		ctx = withVideoCredentials(ctx, config, primary.CredentialValues)
		if refresh {
			return readFresh(ctx)
		}
		filePath, mimeType, err := readSourceFile(ctx, primary)
		if err == nil {
			return filePath, mimeType, nil
		}
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
		if videoResultPending(err) {
			return "", "", err
		}
		retry, _ := RetryableVideoPollError(ctx, err)
		if !retry && !videoMediaLinkRejected(ctx, config, primary.URL, err) {
			return "", "", err
		}
		if strings.TrimSpace(taskID) == "" || (!IsBeefTVVideoConfig(ctx, config) && renew == nil) {
			return "", "", err
		}
		refresh = true
		return readFresh(ctx)
	}
}

// downloadVideoArtifactMap streams remote video results to disk and persists
// them directly into workspace resources via persistDownloadedVideoFile so
// large protocol, ResultAdapter, and custom-channel videos never allocate
// multi-hundred-MiB Go heap buffers. Inline data: URLs are decoded directly.
func downloadVideoArtifactMap(
	ctx context.Context,
	config Config,
	taskID string,
	pollPolicy VideoPollPolicy,
	source VideoResultSource,
	renew videoResultResolver,
	identitySuffix string,
) (map[string]interface{}, error) {
	if raw := strings.TrimSpace(source.URL); strings.HasPrefix(raw, "data:") {
		mimeType, data, err := DecodeProviderDataURL(raw)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			return nil, errors.New("视频结果内容为空")
		}
		mimeType = NormalizedMediaMIMEType(mimeType, data)
		return map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}, nil
	}
	filePath, fileMime, err := RunVideoDownloadFile(ctx, taskID, pollPolicy, videoResultFileDownloader(config, taskID, source, renew))
	if err != nil {
		return nil, err
	}
	defer os.Remove(filePath)
	return persistDownloadedVideoFile(ctx, filePath, fileMime, identitySuffix)
}

func downloadVideoURLArtifactMap(
	ctx context.Context,
	config Config,
	rawURL, taskID string,
	pollPolicy VideoPollPolicy,
	renew ...videoResultURLResolver,
) (map[string]interface{}, error) {
	var resolver videoResultResolver
	if len(renew) > 0 && renew[0] != nil {
		resolver = func(ctx context.Context) (VideoResultSource, error) {
			freshURL, err := renew[0](ctx)
			return VideoResultSource{URL: freshURL}, err
		}
	}
	return downloadVideoArtifactMap(ctx, config, taskID, pollPolicy, VideoResultSource{URL: rawURL}, resolver, "video")
}
