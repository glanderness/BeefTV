package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	beefAPISeedanceUploadCreatePath    = "/video-references/uploads"
	beefAPISeedanceUploadCompletePath  = "/video-references/uploads/complete"
	beefAPISeedanceUploadResponseLimit = int64(1 << 20)
	beefAPISeedanceJSONOverheadBytes   = int64(64 << 10)
	beefAPISeedanceImageMaxBytes       = int64(30 << 20)
	beefAPISeedanceVideoMaxBytes       = int64(200 << 20)
	beefAPISeedanceAudioMaxBytes       = int64(15 << 20)
	beefAPISeedanceUploadTimeout       = 15 * time.Minute
)

var (
	errBeefAPISeedanceUploadRedirect    = errors.New("参考素材上传不允许重定向")
	errBeefAPISeedanceUploadUnavailable = errors.New("暂时无法接收参考素材")
	errBeefAPISeedanceUploadIncomplete  = errors.New("参考素材未能确认，请重新提交")
	errBeefAPISeedanceUploadFormat      = errors.New("无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。")
	errBeefAPISeedanceUploadEmpty       = errors.New("参考素材为空，请重新导入")
)

type beefAPISeedanceMediaReader func(kind string, media providerMedia) (data []byte, mime string, skip bool, err error)

type beefAPISeedanceUploadSession struct {
	UploadURL       string            `json:"upload_url"`
	UploadMethod    string            `json:"upload_method"`
	RequiredHeaders map[string]string `json:"required_headers"`
	Ticket          string            `json:"ticket"`
}

type beefAPISeedanceUploadComplete struct {
	URL    string `json:"url"`
	Kind   string `json:"kind"`
	Mime   string `json:"mime"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type beefAPISeedanceUploadRequest struct {
	Kind   string `json:"kind"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Mime   string `json:"mime"`
}

func (s *Service) prepareBeefAPISeedanceReferences(ctx context.Context, userID string, input *canvasGenerationInput) error {
	if input == nil || input.Mode != "video" || !isBeefAPISeedancePreuploadConfig(input.Config) {
		return nil
	}
	return prepareBeefAPISeedanceReferences(ctx, input.Config, input, func(kind string, media providerMedia) ([]byte, string, bool, error) {
		return s.readBeefAPISeedanceMedia(userID, kind, media)
	})
}

// prepareBeefAPISeedanceReferences uploads built-in BeefAPI Seedance inline
// references through the same generation key, then rewrites each item to the
// completed HTTPS URL. PUT uses only the returned headers and known length.
// Create/complete/read failures return before POST /videos. A 404/501 on the
// first create may keep the previous inline JSON path when that body is still
// under the existing 64 MiB wire limit.
func prepareBeefAPISeedanceReferences(ctx context.Context, config providerConfig, input *canvasGenerationInput, read beefAPISeedanceMediaReader) error {
	if input == nil || !isBeefAPISeedancePreuploadConfig(config) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if read == nil {
		read = readBeefAPISeedanceInlineMedia
	}
	started := false
	for _, group := range beefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			if err := ctx.Err(); err != nil {
				return err
			}
			media := &group.items[index]
			if skipBeefAPISeedanceMedia(*media) {
				continue
			}
			if media.Bytes > 0 {
				if err := validateBeefAPISeedanceMediaSize(group.kind, media.Bytes); err != nil {
					return err
				}
			}
			data, mime, skip, err := read(group.kind, *media)
			if err != nil {
				return err
			}
			if skip {
				continue
			}
			if err := validateBeefAPISeedanceMediaSize(group.kind, int64(len(data))); err != nil {
				return err
			}
			mime, err = canonicalBeefAPISeedanceMime(group.kind, mime, data)
			if err != nil {
				return err
			}
			if group.kind == "video" && isSeedance2Family(config.InterfaceType, config.Model) {
				if err := applySeedance2VideoProbe(config, index, media, data); err != nil {
					return err
				}
			}
			digest := sha256.Sum256(data)
			hexDigest := hex.EncodeToString(digest[:])
			session, err := createBeefAPISeedanceUpload(ctx, config, beefAPISeedanceUploadRequest{
				Kind:   group.kind,
				Bytes:  int64(len(data)),
				SHA256: hexDigest,
				Mime:   mime,
			})
			if !started && beefAPISeedancePreuploadUnavailable(err) {
				return fallbackBeefAPISeedanceInline(ctx, input, read)
			}
			if err != nil {
				return mapBeefAPISeedanceUploadError(err, false)
			}
			started = true
			uploaded, err := completeBeefAPISeedanceUpload(ctx, config, session, data)
			size := int64(len(data))
			data = nil
			if err != nil {
				return err
			}
			if uploaded.Kind != group.kind || uploaded.Bytes != size || uploaded.SHA256 != hexDigest {
				return errBeefAPISeedanceUploadIncomplete
			}
			if _, ok := canonicalBeefAPISeedanceDeclaredMime(group.kind, uploaded.Mime); !ok {
				return errBeefAPISeedanceUploadIncomplete
			}
			media.URL = uploaded.URL
			media.DataURL = ""
			media.StorageKey = ""
			media.MimeType = firstNonEmpty(uploaded.Mime, mime)
			media.Bytes = size
			if uploaded.Bytes > 0 {
				media.Bytes = uploaded.Bytes
			}
		}
	}
	return nil
}

func beefAPISeedanceMediaGroups(input *canvasGenerationInput) []struct {
	kind  string
	items []providerMedia
} {
	return []struct {
		kind  string
		items []providerMedia
	}{
		{"image", input.ReferenceImages},
		{"video", input.ReferenceVideos},
		{"audio", input.ReferenceAudios},
	}
}

func skipBeefAPISeedanceMedia(media providerMedia) bool {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") {
		return true
	}
	return isPublicMediaURL(value)
}

func (s *Service) readBeefAPISeedanceMedia(userID string, kind string, media providerMedia) ([]byte, string, bool, error) {
	if skipBeefAPISeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := decodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if !strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", true, nil
	}
	if media.Bytes > 0 {
		if err := validateBeefAPISeedanceMediaSize(kind, media.Bytes); err != nil {
			return nil, "", false, err
		}
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	resource, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	defer body.Close()
	max := beefAPISeedanceKindMaxBytes(kind)
	data, err := io.ReadAll(io.LimitReader(body, max+1))
	if err != nil {
		return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
}

func readBeefAPISeedanceInlineMedia(_ string, media providerMedia) ([]byte, string, bool, error) {
	if skipBeefAPISeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := decodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", false, errors.New("参考素材未能读取，请重新提交")
	}
	return nil, "", true, nil
}

func fallbackBeefAPISeedanceInline(ctx context.Context, input *canvasGenerationInput, read beefAPISeedanceMediaReader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var total int64
	for _, group := range beefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			if err := ctx.Err(); err != nil {
				return err
			}
			media := &group.items[index]
			if skipBeefAPISeedanceMedia(*media) {
				continue
			}
			if dataURL := strings.TrimSpace(firstNonEmpty(media.DataURL, media.URL)); strings.HasPrefix(dataURL, "data:") {
				total += int64(len(dataURL))
				if total+beefAPISeedanceJSONOverheadBytes > videoJSONRequestLimitBytes {
					return errVideoJSONRequestTooLarge
				}
				if strings.TrimSpace(media.DataURL) == "" {
					media.DataURL = dataURL
					media.URL = ""
				}
				continue
			}
			if media.Bytes > 0 {
				if media.Bytes > int64(^uint(0)>>1) {
					return errVideoJSONRequestTooLarge
				}
				estimated := int64(base64.StdEncoding.EncodedLen(int(media.Bytes))) + 128
				if total+estimated+beefAPISeedanceJSONOverheadBytes > videoJSONRequestLimitBytes {
					return errVideoJSONRequestTooLarge
				}
			}
			data, mime, skip, err := read(group.kind, *media)
			if err != nil {
				return err
			}
			if skip {
				continue
			}
			if err := validateBeefAPISeedanceMediaSize(group.kind, int64(len(data))); err != nil {
				return err
			}
			mime, err = canonicalBeefAPISeedanceMime(group.kind, mime, data)
			if err != nil {
				return err
			}
			if group.kind == "video" && isSeedance2Family(input.Config.InterfaceType, input.Config.Model) {
				if err := applySeedance2VideoProbe(input.Config, index, media, data); err != nil {
					return err
				}
			}
			size := int64(len(data))
			encoded := dataURL(mime, data)
			data = nil
			total += int64(len(encoded))
			if total+beefAPISeedanceJSONOverheadBytes > videoJSONRequestLimitBytes {
				return errVideoJSONRequestTooLarge
			}
			media.DataURL = encoded
			media.URL = ""
			media.MimeType = mime
			media.Bytes = size
		}
	}
	return nil
}

func createBeefAPISeedanceUpload(ctx context.Context, config providerConfig, request beefAPISeedanceUploadRequest) (beefAPISeedanceUploadSession, error) {
	var session beefAPISeedanceUploadSession
	if err := postJSON(ctx, config, beefAPISeedanceUploadCreatePath, request, &session); err != nil {
		return beefAPISeedanceUploadSession{}, err
	}
	if err := validateBeefAPISeedanceSession(session); err != nil {
		return beefAPISeedanceUploadSession{}, err
	}
	return session, nil
}

func completeBeefAPISeedanceUpload(ctx context.Context, config providerConfig, session beefAPISeedanceUploadSession, data []byte) (beefAPISeedanceUploadComplete, error) {
	if err := putBeefAPISeedanceBytes(ctx, session, data); err != nil {
		return beefAPISeedanceUploadComplete{}, mapBeefAPISeedanceUploadError(err, false)
	}
	var uploaded beefAPISeedanceUploadComplete
	if err := postJSON(ctx, config, beefAPISeedanceUploadCompletePath, map[string]string{"ticket": session.Ticket}, &uploaded); err != nil {
		return beefAPISeedanceUploadComplete{}, mapBeefAPISeedanceUploadError(err, true)
	}
	if strings.TrimSpace(uploaded.URL) == "" {
		return beefAPISeedanceUploadComplete{}, errBeefAPISeedanceUploadIncomplete
	}
	if err := validateBeefAPISeedanceSecureURL(uploaded.URL); err != nil {
		return beefAPISeedanceUploadComplete{}, errBeefAPISeedanceUploadUnavailable
	}
	return uploaded, nil
}

func beefAPISeedancePutTimeout(ctx context.Context) time.Duration {
	timeout := beefAPISeedanceUploadTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < timeout {
			return remaining
		}
	}
	return timeout
}

func putBeefAPISeedanceBytes(ctx context.Context, session beefAPISeedanceUploadSession, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateBeefAPISeedanceSecureURL(session.UploadURL); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimSpace(session.UploadURL), bytes.NewReader(data))
	if err != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	req.ContentLength = int64(len(data))
	req.GetBody = nil
	for name, value := range session.RequiredHeaders {
		if skipBeefAPISeedancePutHeader(name) {
			continue
		}
		req.Header.Set(name, value)
	}
	req.Header.Del("Authorization")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Cookie")
	req.Header.Del("X-Api-Key")
	req.Header.Del("X-Goog-Api-Key")
	ApplyDefaultOutboundHeaders(req)
	client := OutboundHTTPClient(beefAPISeedancePutTimeout(ctx))
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errBeefAPISeedanceUploadRedirect
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, beefAPISeedanceUploadResponseLimit+1))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errBeefAPISeedanceUploadUnavailable
	}
	return nil
}

func validateBeefAPISeedanceSession(session beefAPISeedanceUploadSession) error {
	if strings.TrimSpace(session.Ticket) == "" {
		return errBeefAPISeedanceUploadUnavailable
	}
	method := strings.ToUpper(strings.TrimSpace(session.UploadMethod))
	if method != "" && method != http.MethodPut {
		return errBeefAPISeedanceUploadUnavailable
	}
	if err := validateBeefAPISeedanceSecureURL(session.UploadURL); err != nil {
		return err
	}
	return nil
}

func validateBeefAPISeedanceSecureURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" || parsed.User != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	if parsed.Scheme != "https" && !beefAPISeedanceAllowInsecureTestURL(parsed) {
		return errBeefAPISeedanceUploadUnavailable
	}
	if _, err := ValidateOutboundURL(parsed.String()); err != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	return nil
}

func beefAPISeedanceAllowInsecureTestURL(parsed *url.URL) bool {
	return parsed != nil && parsed.Scheme == "http" && strings.TrimSpace(beefAPIVideoBaseURLForTest) != ""
}

func skipBeefAPISeedancePutHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "x-api-key", "x-goog-api-key":
		return true
	default:
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "x-canvas-")
	}
}

func beefAPISeedancePreuploadUnavailable(err error) bool {
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusNotImplemented
}

func mapBeefAPISeedanceUploadError(err error, completing bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, errBeefAPISeedanceUploadRedirect) {
		return errBeefAPISeedanceUploadUnavailable
	}
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return err
		case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
			return errBeefAPISeedanceUploadUnavailable
		case http.StatusBadRequest:
			if message := beefAPISeedanceUserErrorMessage(httpErr.Body); message != "" {
				return errors.New(message)
			}
			if completing {
				return errBeefAPISeedanceUploadIncomplete
			}
			return errors.New("请检查文件类型、大小后再提交")
		}
	}
	if completing {
		return errBeefAPISeedanceUploadIncomplete
	}
	return errBeefAPISeedanceUploadUnavailable
}

func beefAPISeedanceUserErrorMessage(body string) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(body), &payload) != nil {
		return ""
	}
	message := strings.TrimSpace(payload.Error.Message)
	if message == "" {
		return ""
	}
	lower := strings.ToLower(message)
	if strings.Contains(lower, "ticket") || strings.Contains(lower, "sha256") || strings.Contains(lower, "r2") || strings.Contains(lower, "upload_url") {
		return ""
	}
	return message
}

func beefAPISeedanceKindMaxBytes(kind string) int64 {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return beefAPISeedanceImageMaxBytes
	case "video":
		return beefAPISeedanceVideoMaxBytes
	case "audio":
		return beefAPISeedanceAudioMaxBytes
	default:
		return 0
	}
}

func validateBeefAPISeedanceMediaSize(kind string, size int64) error {
	if size <= 0 {
		return errBeefAPISeedanceUploadEmpty
	}
	max := beefAPISeedanceKindMaxBytes(kind)
	if max <= 0 {
		return errBeefAPISeedanceUploadFormat
	}
	if size > max {
		switch kind {
		case "image":
			return errors.New("参考图片不能超过 30MB")
		case "video":
			return errors.New("参考视频不能超过 200MB")
		case "audio":
			return errors.New("参考音频不能超过 15MB")
		default:
			return errBeefAPISeedanceUploadFormat
		}
	}
	return nil
}

func canonicalBeefAPISeedanceMime(kind string, declared string, data []byte) (string, error) {
	if mime, ok := canonicalBeefAPISeedanceDeclaredMime(kind, declared); ok {
		return mime, nil
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if mime, ok := canonicalBeefAPISeedanceDeclaredMime(kind, detected); ok {
		return mime, nil
	}
	return "", errBeefAPISeedanceUploadFormat
}

func canonicalBeefAPISeedanceDeclaredMime(kind, raw string) (string, bool) {
	mime := strings.ToLower(strings.TrimSpace(raw))
	if slash := strings.IndexByte(mime, ';'); slash >= 0 {
		mime = strings.TrimSpace(mime[:slash])
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		switch mime {
		case "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff":
			return mime, true
		case "image/jpg":
			return "image/jpeg", true
		}
	case "video":
		switch mime {
		case "video/mp4", "video/quicktime":
			return mime, true
		}
	case "audio":
		switch mime {
		case "audio/mpeg", "audio/mp3":
			return "audio/mpeg", true
		case "audio/wav", "audio/wave", "audio/x-wav":
			return "audio/wav", true
		}
	}
	return "", false
}
