package generation

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

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
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

const (
	BeefAPISeedanceImageMaxBytes = beefAPISeedanceImageMaxBytes
	BeefAPISeedanceVideoMaxBytes = beefAPISeedanceVideoMaxBytes
	BeefAPISeedanceUploadTimeout = beefAPISeedanceUploadTimeout
)

var (
	ErrBeefAPISeedanceUploadUnavailable = errBeefAPISeedanceUploadUnavailable
	ErrBeefAPISeedanceUploadIncomplete  = errBeefAPISeedanceUploadIncomplete
)

type BeefAPISeedanceMediaReader func(kind string, media Media) (data []byte, mime string, skip bool, err error)

type BeefAPISeedanceUploadSession struct {
	UploadURL       string            `json:"upload_url"`
	UploadMethod    string            `json:"upload_method"`
	RequiredHeaders map[string]string `json:"required_headers"`
	Ticket          string            `json:"ticket"`
}

type BeefAPISeedanceUploadComplete struct {
	URL    string `json:"url"`
	Kind   string `json:"kind"`
	Mime   string `json:"mime"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type BeefAPISeedanceUploadRequest struct {
	Kind   string `json:"kind"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Mime   string `json:"mime"`
}

// prepareBeefAPISeedanceReferences uploads built-in BeefAPI Seedance inline
// references through the same generation key, then rewrites each item to the
// completed HTTPS URL. PUT uses only the returned headers and known length.
// Create/complete/read failures return before POST /videos. A 404/501 on the
// first create may keep the previous inline JSON path when that body is still
// under the existing 64 MiB wire limit.
func PrepareBeefAPISeedanceReferences(ctx context.Context, config Config, input *Input, read BeefAPISeedanceMediaReader) error {
	if input == nil || !IsBeefAPISeedancePreuploadConfig(ctx, config) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if read == nil {
		read = ReadBeefAPISeedanceInlineMedia
	}
	started := false
	for _, group := range BeefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			if err := ctx.Err(); err != nil {
				return err
			}
			media := &group.items[index]
			if SkipBeefAPISeedanceMedia(*media) {
				continue
			}
			if media.Bytes > 0 {
				if err := ValidateBeefAPISeedanceMediaSize(group.kind, media.Bytes); err != nil {
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
			if err := ValidateBeefAPISeedanceMediaSize(group.kind, int64(len(data))); err != nil {
				return err
			}
			mime, err = CanonicalBeefAPISeedanceMime(group.kind, mime, data)
			if err != nil {
				return err
			}
			if group.kind == "video" && modelcatalog.IsSeedance2Family(config.InterfaceType, config.Model) {
				if err := applySeedance2VideoProbe(ctx, config, index, media, data); err != nil {
					return err
				}
			}
			if input.VideoCapability != nil {
				verified := *media
				verified.Bytes = int64(len(data))
				refs := input.VideoCapability.References
				applySeedanceDocumentedVideoPixelFloor(config, &refs)
				switch group.kind {
				case "image":
					err = validateVideoReferenceImage(refs, index, verified)
				case "video":
					err = validateVideoReferenceVideo(refs, index, verified)
				}
				if err != nil {
					return err
				}
			}
			digest := sha256.Sum256(data)
			hexDigest := hex.EncodeToString(digest[:])
			session, err := CreateBeefAPISeedanceUpload(ctx, config, BeefAPISeedanceUploadRequest{
				Kind:   group.kind,
				Bytes:  int64(len(data)),
				SHA256: hexDigest,
				Mime:   mime,
			})
			if !started && BeefAPISeedancePreuploadUnavailable(err) {
				return FallbackBeefAPISeedanceInline(ctx, input, read)
			}
			if err != nil {
				return MapBeefAPISeedanceUploadError(err, false)
			}
			started = true
			uploaded, err := CompleteBeefAPISeedanceUpload(ctx, config, session, data)
			size := int64(len(data))
			data = nil
			if err != nil {
				return err
			}
			if uploaded.Kind != group.kind || uploaded.Bytes != size || uploaded.SHA256 != hexDigest {
				return errBeefAPISeedanceUploadIncomplete
			}
			if _, ok := CanonicalBeefAPISeedanceDeclaredMime(group.kind, uploaded.Mime); !ok {
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

type BeefAPISeedanceMediaGroup struct {
	kind  string
	items []Media
}

func BeefAPISeedanceMediaGroups(input *Input) []BeefAPISeedanceMediaGroup {
	return []BeefAPISeedanceMediaGroup{
		{"image", input.ReferenceImages},
		{"video", input.ReferenceVideos},
		{"audio", input.ReferenceAudios},
	}
}

func SkipBeefAPISeedanceMedia(media Media) bool {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") {
		return true
	}
	return IsPublicMediaURL(value)
}

func ReadBeefAPISeedanceInlineMedia(_ string, media Media) ([]byte, string, bool, error) {
	if SkipBeefAPISeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := DecodeProviderDataURL(raw)
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

func ownedSeedanceMediaReader(ctx context.Context, userID string) BeefAPISeedanceMediaReader {
	return func(kind string, media Media) ([]byte, string, bool, error) {
		if SkipBeefAPISeedanceMedia(media) {
			return nil, "", true, nil
		}
		if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
			return ReadBeefAPISeedanceInlineMedia(kind, media)
		}
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return nil, "", true, nil
		}
		if media.Bytes > 0 {
			if err := ValidateBeefAPISeedanceMediaSize(kind, media.Bytes); err != nil {
				return nil, "", false, err
			}
		}
		runtime, ok := RuntimeFromContext(ctx)
		if !ok || runtime.Resources == nil {
			return nil, "", false, errors.New("读取任务参考资源失败：资源端口未接入")
		}
		resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
		resource, body, err := runtime.Resources.Open(userID, resourceID)
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		defer body.Close()
		max := BeefAPISeedanceKindMaxBytes(kind)
		data, err := io.ReadAll(io.LimitReader(body, max+1))
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
	}
}

func FallbackBeefAPISeedanceInline(ctx context.Context, input *Input, read BeefAPISeedanceMediaReader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var total int64
	for _, group := range BeefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			if err := ctx.Err(); err != nil {
				return err
			}
			media := &group.items[index]
			if SkipBeefAPISeedanceMedia(*media) {
				continue
			}
			if DataURL := strings.TrimSpace(firstNonEmpty(media.DataURL, media.URL)); strings.HasPrefix(DataURL, "data:") {
				total += int64(len(DataURL))
				if total+beefAPISeedanceJSONOverheadBytes > VideoJSONRequestLimitBytes {
					return ErrVideoJSONRequestTooLarge
				}
				if strings.TrimSpace(media.DataURL) == "" {
					media.DataURL = DataURL
					media.URL = ""
				}
				continue
			}
			if media.Bytes > 0 {
				if media.Bytes > int64(^uint(0)>>1) {
					return ErrVideoJSONRequestTooLarge
				}
				estimated := int64(base64.StdEncoding.EncodedLen(int(media.Bytes))) + 128
				if total+estimated+beefAPISeedanceJSONOverheadBytes > VideoJSONRequestLimitBytes {
					return ErrVideoJSONRequestTooLarge
				}
			}
			data, mime, skip, err := read(group.kind, *media)
			if err != nil {
				return err
			}
			if skip {
				continue
			}
			if err := ValidateBeefAPISeedanceMediaSize(group.kind, int64(len(data))); err != nil {
				return err
			}
			mime, err = CanonicalBeefAPISeedanceMime(group.kind, mime, data)
			if err != nil {
				return err
			}
			if group.kind == "video" && modelcatalog.IsSeedance2Family(input.Config.InterfaceType, input.Config.Model) {
				if err := applySeedance2VideoProbe(ctx, input.Config, index, media, data); err != nil {
					return err
				}
			}
			size := int64(len(data))
			encoded := DataURL(mime, data)
			data = nil
			total += int64(len(encoded))
			if total+beefAPISeedanceJSONOverheadBytes > VideoJSONRequestLimitBytes {
				return ErrVideoJSONRequestTooLarge
			}
			media.DataURL = encoded
			media.URL = ""
			media.MimeType = mime
			media.Bytes = size
		}
	}
	return nil
}

func CreateBeefAPISeedanceUpload(ctx context.Context, config Config, request BeefAPISeedanceUploadRequest) (BeefAPISeedanceUploadSession, error) {
	var session BeefAPISeedanceUploadSession
	if err := PostJSON(ctx, config, beefAPISeedanceUploadCreatePath, request, &session); err != nil {
		return BeefAPISeedanceUploadSession{}, err
	}
	if err := ValidateBeefAPISeedanceSession(ctx, session); err != nil {
		return BeefAPISeedanceUploadSession{}, err
	}
	return session, nil
}

func CompleteBeefAPISeedanceUpload(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (BeefAPISeedanceUploadComplete, error) {
	if err := PutBeefAPISeedanceBytes(ctx, session, data); err != nil {
		return BeefAPISeedanceUploadComplete{}, MapBeefAPISeedanceUploadError(err, false)
	}
	var uploaded BeefAPISeedanceUploadComplete
	if err := PostJSON(ctx, config, beefAPISeedanceUploadCompletePath, map[string]string{"ticket": session.Ticket}, &uploaded); err != nil {
		return BeefAPISeedanceUploadComplete{}, MapBeefAPISeedanceUploadError(err, true)
	}
	if strings.TrimSpace(uploaded.URL) == "" {
		return BeefAPISeedanceUploadComplete{}, errBeefAPISeedanceUploadIncomplete
	}
	if err := ValidateBeefAPISeedanceSecureURL(ctx, uploaded.URL); err != nil {
		return BeefAPISeedanceUploadComplete{}, errBeefAPISeedanceUploadUnavailable
	}
	return uploaded, nil
}

func BeefAPISeedancePutTimeout(ctx context.Context) time.Duration {
	timeout := beefAPISeedanceUploadTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < timeout {
			return remaining
		}
	}
	return timeout
}

func PutBeefAPISeedanceBytes(ctx context.Context, session BeefAPISeedanceUploadSession, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateBeefAPISeedanceSecureURL(ctx, session.UploadURL); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimSpace(session.UploadURL), bytes.NewReader(data))
	if err != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	req.ContentLength = int64(len(data))
	req.GetBody = nil
	for name, value := range session.RequiredHeaders {
		if SkipBeefAPISeedancePutHeader(name) {
			continue
		}
		req.Header.Set(name, value)
	}
	req.Header.Del("Authorization")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Cookie")
	req.Header.Del("X-Api-Key")
	req.Header.Del("X-Goog-Api-Key")
	outbound.ApplyDefaultOutboundHeaders(req)
	client := outbound.OutboundHTTPClient(BeefAPISeedancePutTimeout(ctx))
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

func ValidateBeefAPISeedanceSession(ctx context.Context, session BeefAPISeedanceUploadSession) error {
	if strings.TrimSpace(session.Ticket) == "" {
		return errBeefAPISeedanceUploadUnavailable
	}
	method := strings.ToUpper(strings.TrimSpace(session.UploadMethod))
	if method != "" && method != http.MethodPut {
		return errBeefAPISeedanceUploadUnavailable
	}
	if err := ValidateBeefAPISeedanceSecureURL(ctx, session.UploadURL); err != nil {
		return err
	}
	return nil
}

func ValidateBeefAPISeedanceSecureURL(ctx context.Context, raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" || parsed.User != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	if parsed.Scheme != "https" && !BeefAPISeedanceAllowInsecureTestURL(ctx, parsed) {
		return errBeefAPISeedanceUploadUnavailable
	}
	if _, err := outbound.ValidateOutboundURL(parsed.String()); err != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	return nil
}

func BeefAPISeedanceAllowInsecureTestURL(ctx context.Context, parsed *url.URL) bool {
	return parsed != nil && parsed.Scheme == "http" && beefAPITestBaseURL(ctx) != ""
}

func SkipBeefAPISeedancePutHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "x-api-key", "x-goog-api-key":
		return true
	default:
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "x-canvas-")
	}
}

func BeefAPISeedancePreuploadUnavailable(err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusNotImplemented
}

func MapBeefAPISeedanceUploadError(err error, completing bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, errBeefAPISeedanceUploadRedirect) {
		return errBeefAPISeedanceUploadUnavailable
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return err
		case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
			return errBeefAPISeedanceUploadUnavailable
		case http.StatusBadRequest:
			if message := BeefAPISeedanceUserErrorMessage(httpErr.Body); message != "" {
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

func BeefAPISeedanceUserErrorMessage(body string) string {
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

func BeefAPISeedanceKindMaxBytes(kind string) int64 {
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

func ValidateBeefAPISeedanceMediaSize(kind string, size int64) error {
	if size <= 0 {
		return errBeefAPISeedanceUploadEmpty
	}
	max := BeefAPISeedanceKindMaxBytes(kind)
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

func CanonicalBeefAPISeedanceMime(kind string, declared string, data []byte) (string, error) {
	if mime, ok := CanonicalBeefAPISeedanceDeclaredMime(kind, declared); ok {
		return mime, nil
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if mime, ok := CanonicalBeefAPISeedanceDeclaredMime(kind, detected); ok {
		return mime, nil
	}
	return "", errBeefAPISeedanceUploadFormat
}

func CanonicalBeefAPISeedanceDeclaredMime(kind, raw string) (string, bool) {
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
