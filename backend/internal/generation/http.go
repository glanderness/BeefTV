package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/outbound"
)

const (
	HTTPTimeout                      = 5 * time.Minute
	VideoPollTimeout                 = time.Hour
	MaxResponseBytes           int64 = 64 << 20
	VideoJSONRequestLimitBytes int64 = 64 << 20
	ResourceURLTTL                   = 4 * time.Hour
)

var ErrVideoJSONRequestTooLarge = errors.New("video request body exceeds the 64 MiB request limit; use public media URLs instead of inline base64")

type submissionKeyContext struct{}

func WithSubmissionKey(ctx context.Context, key string) context.Context {
	key = strings.TrimSpace(key)
	if key == "" {
		return ctx
	}
	return context.WithValue(ctx, submissionKeyContext{}, key)
}

func SubmissionKeyFromContext(ctx context.Context) string {
	key, _ := ctx.Value(submissionKeyContext{}).(string)
	return strings.TrimSpace(key)
}

func PostJSON(ctx context.Context, config Config, path string, body interface{}, target interface{}) error {
	req, err := newJSONRequest(ctx, http.MethodPost, APIURL(config.BaseURL, path), config, body)
	if err != nil {
		return err
	}
	return DoJSON(req, target)
}

func PostJSONWithSubmissionKey(ctx context.Context, config Config, path string, body interface{}, target interface{}) error {
	req, err := newJSONRequest(ctx, http.MethodPost, APIURL(config.BaseURL, path), config, body)
	if err != nil {
		return err
	}
	if key := SubmissionKeyFromContext(ctx); key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	req.GetBody = nil
	return UncertainVideoSubmission(ctx, DoJSON(req, target))
}

func GetJSON(ctx context.Context, config Config, path string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, APIURL(config.BaseURL, path), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoJSON(req, target)
}

func PostForm(ctx context.Context, config Config, path string, contentType string, body io.Reader, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, APIURL(config.BaseURL, path), body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Content-Type", contentType)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoJSON(req, target)
}

func PostBinary(ctx context.Context, config Config, path string, body interface{}) ([]byte, string, error) {
	req, err := newJSONRequest(ctx, http.MethodPost, APIURL(config.BaseURL, path), config, body)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoBinary(req)
}

func GetBinary(ctx context.Context, config Config, path string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, APIURL(config.BaseURL, path), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoBinary(req)
}

func GetExternalBinary(ctx context.Context, rawURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	return DoBinary(req)
}

func GetProviderExternalBinary(ctx context.Context, config Config, rawURL string) ([]byte, string, error) {
	downloadURL := ProviderDownloadURL(config.BaseURL, rawURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, "", err
	}
	if SameProviderOrigin(config.BaseURL, downloadURL) {
		ApplyAuth(req, config)
		outbound.ApplyOutboundHeaders(req, config.Headers)
	}
	return DoBinary(req)
}

func PostStreamingBinary(ctx context.Context, config Config, path string, body interface{}, onChunk func(string, []byte)) ([]byte, string, error) {
	req, err := newJSONRequest(ctx, http.MethodPost, APIURL(config.BaseURL, path), config, body)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "text/event-stream")
	return DoBinaryWithConsumer(req, onChunk)
}

func PostGeminiJSON(ctx context.Context, config Config, path string, body interface{}, target interface{}) error {
	req, err := newJSONRequest(ctx, http.MethodPost, GeminiURL(config.BaseURL, path), config, body)
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoJSON(req, target)
}

func GetGeminiJSON(ctx context.Context, config Config, path string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, GeminiURL(config.BaseURL, path), nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoJSON(req, target)
}

func GetGeminiBinary(ctx context.Context, config Config, rawURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return DoBinary(req)
}

func newJSONRequest(ctx context.Context, method, rawURL string, config Config, body interface{}) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("序列化上游请求失败：%w", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, err
	}
	ApplyAuth(req, config)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return req, nil
}

func DoJSON(req *http.Request, target interface{}) error {
	data, mimeType, err := DoBinary(req)
	if err != nil {
		return err
	}
	if !strings.Contains(mimeType, "json") && !json.Valid(data) {
		return ResponseDecodeError{Err: fmt.Errorf("接口返回非 JSON 内容：%s", mimeType)}
	}
	if err := json.Unmarshal(data, target); err != nil {
		return ResponseDecodeError{Err: err}
	}
	if payload, ok := target.(*ImageResponse); ok {
		if payload.Error != nil && (payload.Error.Message != "" || normalizedUpstreamErrorCode(payload.Error.Code) != "") {
			encoded, _ := json.Marshal(payload.Error)
			raw := string(encoded)
			return NewPayloadError(raw, ClassifyText(raw).UserMessage())
		}
		if payload.Code != nil && businessCodeFailed(*payload.Code) {
			encoded, _ := json.Marshal(payload)
			raw := string(encoded)
			return NewPayloadError(raw, ClassifyText(raw).UserMessage())
		}
	}
	if payload, ok := target.(*map[string]interface{}); ok {
		if _, rawMessage, failed := PayloadBusinessFailure(*payload); failed {
			encoded, _ := json.Marshal(*payload)
			raw := string(encoded)
			if strings.TrimSpace(raw) == "" || raw == "null" {
				raw = rawMessage
			}
			return NewPayloadError(raw, ClassifyText(raw).UserMessage())
		}
		if errValue, ok := (*payload)["error"].(map[string]interface{}); ok && stringMapField(errValue, "message") != "" {
			encoded, _ := json.Marshal(*payload)
			raw := string(encoded)
			return NewPayloadError(raw, ClassifyText(raw).UserMessage())
		}
	}
	return nil
}

func DoBinary(req *http.Request) ([]byte, string, error) {
	if RecoverableImageEndpoint(req) {
		runtime, ok := RuntimeFromContext(req.Context())
		if !ok || runtime.Images == nil {
			return nil, "", ErrImageOwnerMissing
		}
		handled, data, mimeType, err := runtime.Images.Intercept(req)
		if !handled {
			return nil, "", ErrImageOwnerMissing
		}
		return data, mimeType, err
	}
	if runtime, ok := RuntimeFromContext(req.Context()); ok && runtime.Images != nil {
		handled, data, mimeType, err := runtime.Images.Intercept(req)
		if handled {
			return data, mimeType, err
		}
	}
	return DoBinaryWithConsumer(req, nil)
}

func DoBinaryWithConsumer(req *http.Request, onChunk func(string, []byte)) (responseData []byte, responseMime string, resultErr error) {
	startedAt := time.Now()
	observation := TransportObservation{Request: req, StartedAt: startedAt, ResponseLimitBytes: MaxResponseBytes}
	defer func() {
		observation.Body = responseData
		observation.Err = resultErr
		if runtime, ok := RuntimeFromContext(req.Context()); ok && runtime.Receipts != nil {
			runtime.Receipts.Observe(observation)
		}
	}()
	requestTimeout := HTTPTimeout
	if deadline, ok := req.Context().Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 {
			requestTimeout = remaining
		}
	}
	responseLimit := MaxResponseBytes
	channelID := ""
	runtime, hasRuntime := RuntimeFromContext(req.Context())
	if hasRuntime && runtime.Limits != nil {
		channelID = runtime.Call.ChannelID
		limit, err := runtime.Limits.GeneratedFileBytes(req.Context())
		if err != nil {
			return nil, "", fmt.Errorf("读取生成资源限制失败：%w", err)
		}
		responseLimit = limit
		observation.ResponseLimitBytes = responseLimit
		open, err := runtime.Limits.CircuitOpen(req.Context(), channelID)
		if err != nil {
			return nil, "", fmt.Errorf("读取渠道熔断状态失败：%w", err)
		}
		if open {
			return nil, "", CircuitOpenError{}
		}
		slotID := channelID
		if slotID == "" {
			slotID = "custom:" + strings.ToLower(req.URL.Host)
		}
		release, concurrencyLimit, err := runtime.Limits.AcquireChannelSlot(req.Context(), channelID, slotID, requestTimeout+time.Minute)
		runtime.Call.ConcurrencyLimit = concurrencyLimit
		req = req.WithContext(WithRuntime(req.Context(), runtime))
		observation.Request = req
		if err != nil {
			return nil, "", err
		}
		defer release()
	}
	if _, err := outbound.ValidateOutboundURL(req.URL.String()); err != nil {
		return nil, "", err
	}
	outbound.ApplyDefaultOutboundHeaders(req)
	client := outbound.OutboundHTTPClient(requestTimeout)
	observation.Dispatched = true
	resp, err := client.Do(req)
	if err != nil {
		if hasRuntime && runtime.Limits != nil {
			_ = runtime.Limits.RecordChannelResult(req.Context(), channelID, !errors.Is(err, context.Canceled))
		}
		return nil, "", err
	}
	defer resp.Body.Close()
	observation.HTTPStatus = resp.StatusCode
	observation.StatusCode = resp.StatusCode
	observation.DeclaredResponseBytes = resp.ContentLength
	observation.RequestID = firstNonEmpty(resp.Header.Get("X-Request-Id"), resp.Header.Get("Request-Id"))
	if resp.ContentLength > responseLimit {
		observation.Outcome = "response_limit"
		return nil, "", fmt.Errorf("上游响应超过 %s 限制", formatStorageLimit(responseLimit))
	}
	mimeType := resp.Header.Get("Content-Type")
	var buffered bytes.Buffer
	reader := io.LimitReader(resp.Body, responseLimit+1)
	chunk := make([]byte, 32<<10)
	for {
		readCount, readErr := reader.Read(chunk)
		observation.ReceivedBytes += int64(readCount)
		if readCount > 0 {
			if int64(buffered.Len()+readCount) > responseLimit {
				observation.Outcome = "response_limit"
				return nil, "", fmt.Errorf("上游响应超过 %s 限制", formatStorageLimit(responseLimit))
			}
			_, _ = buffered.Write(chunk[:readCount])
			if onChunk != nil {
				onChunk(mimeType, chunk[:readCount])
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, "", readErr
		}
	}
	data := buffered.Bytes()
	if int64(len(data)) > responseLimit {
		return nil, "", fmt.Errorf("上游响应超过 %s 限制", formatStorageLimit(responseLimit))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if hasRuntime && runtime.Limits != nil {
			_ = runtime.Limits.RecordChannelResult(req.Context(), channelID, resp.StatusCode >= 500)
		}
		httpErr := HTTPError{
			RequestID:           firstNonEmpty(resp.Header.Get("X-Request-Id"), resp.Header.Get("Request-Id")),
			StatusCode:          resp.StatusCode,
			Status:              resp.Status,
			Body:                string(data),
			RetryAfter:          ParseRetryAfter(resp.Header.Get("Retry-After"), time.Now()),
			IdempotencyReplayed: strings.EqualFold(resp.Header.Get("Idempotency-Replayed"), "true"),
		}
		observation.StatusCode = resp.StatusCode
		return nil, "", httpErr
	}
	observation.StatusCode = resp.StatusCode
	if hasRuntime && runtime.Limits != nil {
		_ = runtime.Limits.RecordChannelResult(req.Context(), channelID, false)
	}
	return data, mimeType, nil
}

func ParseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}

func PollingDeadline(ctx context.Context) time.Time {
	if deadline, ok := ctx.Deadline(); ok {
		return deadline
	}
	return time.Now().Add(VideoPollTimeout)
}

func GeneratedFileLimit(ctx context.Context) (int64, error) {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Limits == nil {
		return MaxResponseBytes, nil
	}
	return runtime.Limits.GeneratedFileBytes(ctx)
}

func formatStorageLimit(value int64) string {
	if value%(1<<30) == 0 {
		return fmt.Sprintf("%dGB", value>>30)
	}
	return fmt.Sprintf("%dMB", value>>20)
}

func defaultString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func megabytes(value int64) int64 { return kernel.Megabytes(value) }
