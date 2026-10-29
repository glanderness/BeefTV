package beefapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

const MediaProtocolHeader = "X-BeefAPI-Media-Protocol"
const MediaProtocolVersion = "managed-media-v1"

type MediaDiscovery struct {
	Version              string   `json:"version"`
	SupportedMediaTypes  []string `json:"supported_media_types"`
	TaskSubmitURL        string   `json:"task_submit_url"`
	TaskQueryURLTemplate string   `json:"task_query_url_template"`
	UploadsURL           string   `json:"uploads_url"`
}
type MediaReference struct {
	Kind string `json:"kind"`
	Role string `json:"role"`
	URL  string `json:"url"`
}
type LocalMediaReference struct {
	MediaReference
	StorageKey string
	DataURL    string
	MIME       string
	Bytes      int64
	MaxBytes   int64
}
type MediaRequest struct {
	TaskRef   string `json:"task_ref"`
	MediaType string `json:"media_type"`
	Model     string `json:"model"`
	Operation string `json:"operation"`
	Input     struct {
		Prompt     string           `json:"prompt"`
		References []MediaReference `json:"references,omitempty"`
	} `json:"input"`
	Options map[string]any `json:"options,omitempty"`
}
type MediaOutput struct {
	Kind     string         `json:"kind"`
	URL      string         `json:"url"`
	Metadata map[string]any `json:"metadata,omitempty"`
}
type MediaReceipt struct {
	Format    string `json:"format"`
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expires_at"`
}
type MediaTaskError struct {
	Code     string `json:"code"`
	Category string `json:"category"`
	Message  string `json:"message"`
	TaskID   string `json:"task_id,omitempty"`
}

func (e *MediaTaskError) Error() string { return e.Message }

type MediaTask struct {
	TaskRef           string          `json:"task_ref"`
	MediaType         string          `json:"media_type"`
	Status            string          `json:"status"`
	TaskID            string          `json:"task_id,omitempty"`
	Outputs           []MediaOutput   `json:"outputs"`
	Metadata          map[string]any  `json:"metadata,omitempty"`
	Usage             json.RawMessage `json:"usage,omitempty"`
	BillingState      *string         `json:"billing_state,omitempty"`
	UsageState        *string         `json:"usage_state,omitempty"`
	Quota             *int64          `json:"quota,omitempty"`
	ReservedQuota     *int64          `json:"reserved_quota,omitempty"`
	ChargedQuota      *int64          `json:"charged_quota,omitempty"`
	AdjustmentQuota   *int64          `json:"adjustment_quota,omitempty"`
	ReconcileDeadline *int64          `json:"reconcile_deadline,omitempty"`
	ResultReceipt     *MediaReceipt   `json:"result_receipt,omitempty"`
	Error             *MediaTaskError `json:"error,omitempty"`
}

// State only fences the first send and stores the original attempt identity.
// Provider recovery and dispatch retries belong to the API, never this client.
type MediaStatePort interface {
	Sent(context.Context) (bool, error)
	Begin(*http.Request) (alreadySent bool, err error)
}
type MediaProjectionPort interface {
	Project(context.Context, MediaTask)
}
type MediaClient struct {
	BaseURL           string
	APIKey            string
	Headers           http.Header
	Client            *http.Client
	AllowHTTPTest     bool
	State             MediaStatePort
	Open              func(context.Context, string) (io.ReadCloser, string, int64, error)
	Progress          func(label string, loaded, total int64, phase string)
	Observe           func(*http.Request, *http.Response, []byte, error)
	StorageObserve    func(UploadObservation)
	InspectReference  func(context.Context, LocalMediaReference, io.ReaderAt, int64, string) error
	ReferenceUploaded func(LocalMediaReference, UploadedMedia)
	Poll              func(context.Context) error
	Project           func(context.Context, MediaTask)
}

func (c *MediaClient) endpoint(path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil || base.Host == "" || base.User != nil {
		return "", errors.New("模型服务地址无效")
	}
	if !strings.HasSuffix(base.Path, "/v1") {
		base.Path = strings.TrimRight(base.Path, "/") + "/v1"
	}
	if strings.HasPrefix(path, "/v1/") {
		path = strings.TrimPrefix(path, "/v1")
	}
	escaped := strings.TrimRight(base.EscapedPath(), "/") + "/" + strings.TrimLeft(path, "/")
	decoded, err := url.PathUnescape(escaped)
	if err != nil {
		return "", err
	}
	base.Path, base.RawPath = decoded, escaped
	base.RawQuery, base.Fragment = "", ""
	return base.String(), nil
}
func (c *MediaClient) httpClient() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return outbound.OutboundHTTPClient(5 * time.Minute)
}
func (c *MediaClient) validURL(raw string) error {
	return c.validURLContext(context.Background(), raw)
}
func (c *MediaClient) validURLContext(ctx context.Context, raw string) error {
	if !c.AllowHTTPTest {
		_, err := outbound.ValidatePublicHTTPSURLContext(ctx, raw)
		return err
	}
	u, err := outbound.ValidateOutboundURLContext(ctx, raw)
	if err != nil {
		return err
	}
	if u.User != nil || (u.Scheme != "https" && !(c.AllowHTTPTest && u.Scheme == "http")) {
		return errors.New("媒体地址需要安全的 HTTPS 链接")
	}
	return nil
}
func (c *MediaClient) request(ctx context.Context, method, path string, body any) (*http.Request, error) {
	ctx = c.networkContext(ctx)
	raw, err := c.endpoint(path)
	if err != nil {
		return nil, err
	}
	if err = c.validURLContext(ctx, raw); err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		data, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, raw, reader)
	if err != nil {
		return nil, err
	}
	for name, values := range c.Headers {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	for _, key := range []string{"Idempotency-Key", "X-Idempotency-Key", "Content-Length", "Transfer-Encoding"} {
		req.Header.Del(key)
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set(MediaProtocolHeader, MediaProtocolVersion)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.GetBody = nil
	return req, nil
}

func (c *MediaClient) networkContext(ctx context.Context) context.Context {
	if !c.AllowHTTPTest {
		return outbound.WithPublicHTTPS(ctx)
	}
	return ctx
}
func (c *MediaClient) send(req *http.Request, limit int64) ([]byte, http.Header, error) {
	client := *c.httpClient()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	var data []byte
	if err == nil {
		defer resp.Body.Close()
		data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err == nil && int64(len(data)) > limit {
			err = errors.New("媒体服务控制响应过大")
		}
		if err == nil && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
			var envelope struct {
				Error MediaTaskError `json:"error"`
			}
			_ = json.Unmarshal(data, &envelope)
			if envelope.Error.Message == "" {
				envelope.Error.Message = fmt.Sprintf("媒体服务请求未能确认（HTTP %d）", resp.StatusCode)
			}
			err = &MediaHTTPError{StatusCode: resp.StatusCode, TaskError: envelope.Error, Body: string(data), RequestID: resp.Header.Get("X-Request-Id")}
		}
	}
	if c.Observe != nil {
		c.Observe(req, resp, data, err)
	}
	if resp != nil {
		return data, resp.Header, err
	}
	return data, nil, err
}

type MediaHTTPError struct {
	StatusCode int
	TaskError  MediaTaskError
	Body       string
	RequestID  string
}

func (e *MediaHTTPError) Error() string { return e.TaskError.Message }

func (c *MediaClient) Discover(ctx context.Context) (MediaDiscovery, error) {
	req, err := c.request(ctx, http.MethodGet, "/models", nil)
	if err != nil {
		return MediaDiscovery{}, err
	}
	data, header, err := c.send(req, 4<<20)
	if err != nil {
		return MediaDiscovery{}, err
	}
	var payload struct {
		MediaProtocol MediaDiscovery `json:"media_protocol"`
	}
	if json.Unmarshal(data, &payload) != nil || header.Get(MediaProtocolHeader) != MediaProtocolVersion || payload.MediaProtocol.Version != MediaProtocolVersion {
		return MediaDiscovery{}, errors.New("图片服务暂不支持当前媒体协议，本次尚未开始生成")
	}
	d := payload.MediaProtocol
	if d.TaskSubmitURL != "/v1/media/tasks" || d.TaskQueryURLTemplate != "/v1/media/tasks/{task_ref}" || d.UploadsURL != "/v1/media/uploads" {
		return MediaDiscovery{}, errors.New("媒体服务任务接口声明无效，本次尚未开始生成")
	}
	return d, nil
}

func (c *MediaClient) Execute(ctx context.Context, request MediaRequest, refs []LocalMediaReference) (map[string]any, error) {
	if request.TaskRef == "" || c.State == nil {
		return nil, errors.New("媒体任务缺少持久化提交身份")
	}
	// Consult the existing send fence before opening a reference. A restart can
	// collect the task even after the original local files have been deleted.
	sent, err := c.State.Sent(ctx)
	if err != nil {
		return nil, err
	}
	if sent {
		return c.Wait(ctx, request.TaskRef, request.MediaType, false)
	}
	d, err := c.Discover(ctx)
	if err != nil {
		return nil, err
	}
	supported := false
	for _, kind := range d.SupportedMediaTypes {
		if kind == request.MediaType {
			supported = true
		}
	}
	if !supported {
		return nil, errors.New("媒体服务尚未支持当前任务类型")
	}
	for _, ref := range refs {
		link, err := c.UploadReference(ctx, ref)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(link, "https://") && !c.AllowHTTPTest {
			return nil, errors.New("媒体参考素材需要 HTTPS 链接")
		}
		request.Input.References = append(request.Input.References, MediaReference{Kind: ref.Kind, Role: ref.Role, URL: link})
	}
	// Fixed content options only; stale protocol/plugin settings never enter wire.
	for _, key := range []string{"response_format", "model", "task_ref", "references", "image", "images", "mask", "transport", "protocol"} {
		delete(request.Options, key)
	}
	req, err := c.request(ctx, http.MethodPost, d.TaskSubmitURL, request)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Idempotency-Key", request.TaskRef)
	already, err := c.State.Begin(req)
	if err != nil {
		return nil, err
	}
	if !already {
		data, _, sendErr := c.send(req, 4<<20)
		if sendErr == nil {
			task, decodeErr := decodeMediaTask(data, request.TaskRef, request.MediaType)
			if decodeErr == nil && c.Project != nil {
				c.Project(ctx, task)
			}
			if decodeErr == nil && task.Status == "completed" {
				return c.Result(ctx, task, false)
			}
			if decodeErr == nil && task.Status == "failed" {
				return nil, task.failure()
			}
		}
		// Any dispatched result, including 429 or a lost response, is observed by
		// GET thereafter. Never automatically create another request/key here.
	}
	return c.Wait(ctx, request.TaskRef, request.MediaType, false)
}

func decodeMediaTask(data []byte, ref, kind string) (MediaTask, error) {
	var task MediaTask
	if json.Unmarshal(data, &task) != nil || task.TaskRef != ref || task.MediaType != kind {
		return task, errors.New("媒体任务响应身份不一致")
	}
	return task, nil
}
func (c *MediaClient) Query(ctx context.Context, ref, kind string) (MediaTask, error) {
	if ref == "" {
		return MediaTask{}, errors.New("媒体任务编号为空")
	}
	req, err := c.request(ctx, http.MethodGet, "/media/tasks/"+url.PathEscape(ref), nil)
	if err != nil {
		return MediaTask{}, err
	}
	q := req.URL.Query()
	q.Set("media_type", kind)
	req.URL.RawQuery = q.Encode()
	data, _, err := c.send(req, 4<<20)
	if err != nil {
		return MediaTask{}, err
	}
	task, err := decodeMediaTask(data, ref, kind)
	if err == nil && c.Project != nil {
		c.Project(ctx, task)
	}
	return task, err
}
func (c *MediaClient) Wait(ctx context.Context, ref, kind string, legacy bool) (map[string]any, error) {
	for {
		task, err := c.Query(ctx, ref, kind)
		if err == nil {
			switch task.Status {
			case "completed":
				return c.Result(ctx, task, legacy)
			case "failed":
				return nil, task.failure()
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if c.Poll != nil {
			if err = c.Poll(ctx); err != nil {
				return nil, err
			}
		} else {
			timer := time.NewTimer(2500 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
	}
}
func (t MediaTask) failure() error {
	if t.Error != nil {
		return t.Error
	}
	return &MediaTaskError{Code: "media_task_failed", Category: "unknown", Message: "媒体生成失败，请保留原任务查询结算"}
}
