package beeftv

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

const historicalReceiptLimit = int64(64 << 20)

// Storage requests deliberately have no API or provider headers. Redirects are
// validated independently, so a different storage vendor needs no client update.
func (c *MediaClient) storageJSON(ctx context.Context, receipt MediaReceipt) ([]byte, error) {
	ctx = c.networkContext(ctx)
	if receipt.Format != "openai-image-response" || receipt.ExpiresAt <= time.Now().Unix() {
		return nil, errors.New("历史图片回执已过期或格式不受支持，请重新查询原任务")
	}
	if err := c.validURLContext(ctx, receipt.URL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, receipt.URL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.storageClient("历史回执重定向次数过多").Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("历史图片回执下载失败，请重新查询原任务")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, historicalReceiptLimit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > historicalReceiptLimit {
		return nil, errors.New("历史图片回执超过可读取大小")
	}
	return data, nil
}

// storageClient follows redirects to public HTTPS object storage only. Every
// hop is validated, and each hop starts without headers or cookies, so the API
// key and custom API headers never reach storage.
func (c *MediaClient) storageClient(tooMany string) *http.Client {
	client := *c.httpClient()
	client.Jar = nil
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		next.Header = make(http.Header)
		if len(via) >= storageRedirectLimit {
			return errors.New(tooMany)
		}
		return c.validURLContext(next.Context(), next.URL.String())
	}
	return &client
}

const (
	storageRedirectLimit         = 10
	storageStreamHeaderTimeout   = 45 * time.Second
	storageStreamIdleReadTimeout = 60 * time.Second
)

// downloadStorageToFile streams a /content download directly to a file on disk
// using outbound's shared resumable/streaming primitives so 1-2 GiB tool results
// never enter Go heap memory or hang indefinitely. When /content redirects to an
// object-storage URL and destDir is provided, the storage hop runs through
// outbound.DownloadResumableToFile for full Range resume; direct 200 responses
// stream through outbound.StreamResponseToFile. The caller owns the returned
// file path and must remove it when done.
func (c *MediaClient) downloadStorageToFile(ctx context.Context, path, tooMany, destDir string, limit int64) (filePath, mimeType string, size int64, retErr error) {
	contentPath := path
	if !strings.HasSuffix(contentPath, "/content") {
		contentPath += "/content"
	}
	reqCtx, stopHeader, reqCancel := outbound.WithHeaderTimeout(ctx, storageStreamHeaderTimeout)
	defer reqCancel(nil)
	defer stopHeader()
	req, err := c.request(reqCtx, http.MethodGet, contentPath, nil)
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Del(MediaProtocolHeader)

	client := c.storageClient(tooMany)
	client.Timeout = 0
	if strings.TrimSpace(destDir) != "" {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	startedAt := time.Now()
	var resp *http.Response
	var errSnippet []byte
	observe := true
	defer func() {
		if observe && c.Observe != nil {
			c.Observe(req, resp, errSnippet, startedAt, retErr)
		}
	}()

	resp, err = client.Do(req)
	stopHeader()
	if err != nil {
		if cause := context.Cause(reqCtx); cause != nil && ctx.Err() == nil {
			err = cause
		}
		return "", "", 0, err
	}
	closed := false
	closeResp := func() {
		if !closed {
			closed = true
			_ = resp.Body.Close()
		}
	}
	defer closeResp()

	if strings.TrimSpace(destDir) != "" && isRedirectStatus(resp.StatusCode) {
		if loc := strings.TrimSpace(resp.Header.Get("Location")); loc != "" {
			if resolved, parseErr := req.URL.Parse(loc); parseErr == nil {
				// Release the 3xx control-plane connection immediately before
				// starting a potentially multi-minute 1-2 GiB storage download.
				_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
				closeResp()
				targetURL := resolved.String()
				if valErr := c.validURLContext(ctx, targetURL); valErr != nil {
					observe = false
					return "", "", 0, valErr
				}
				return c.downloadStorageRedirectResumable(ctx, contentPath, targetURL, tooMany, destDir, limit)
			}
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errSnippet, _ = io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		var envelope struct {
			Error MediaTaskError `json:"error"`
		}
		_ = json.Unmarshal(errSnippet, &envelope)
		if envelope.Error.Message == "" {
			envelope.Error.Message = fmt.Sprintf("媒体服务请求未能确认（HTTP %d）", resp.StatusCode)
		}
		return "", "", 0, &MediaHTTPError{StatusCode: resp.StatusCode, TaskError: envelope.Error, Body: string(errSnippet), RequestID: resp.Header.Get("X-Request-Id")}
	}
	res, err := outbound.StreamResponseToFile(ctx, resp, outbound.StreamFileOptions{
		Dir:         destDir,
		MaxBytes:    outbound.ExclusiveByteLimit(limit),
		IdleTimeout: storageStreamIdleReadTimeout,
		Cancel:      func() { reqCancel(context.DeadlineExceeded) },
	})
	if err != nil {
		if errors.Is(err, outbound.ErrResourceTooLarge) {
			err = errors.New("媒体服务控制响应过大")
		}
		return "", "", 0, err
	}
	return res.Path, res.MimeType, res.Size, nil
}

func (c *MediaClient) downloadStorageRedirectResumable(ctx context.Context, contentPath, targetURL, tooMany, destDir string, limit int64) (string, string, int64, error) {
	sum := sha256.Sum256([]byte(contentPath))
	storageHopClient := c.storageClient(tooMany)
	storageHopClient.Timeout = 0
	if limit <= 0 {
		limit = 2 << 30
	}
	res, err := outbound.DownloadResumableToFile(c.networkContext(ctx), targetURL, outbound.ResumableOptions{
		PartialPath:   filepath.Join(destDir, "beeftv-content-"+hex.EncodeToString(sum[:8])+".part"),
		MaxBytes:      outbound.ExclusiveByteLimit(limit),
		Attempts:      2,
		HeaderTimeout: storageStreamHeaderTimeout,
		IdleTimeout:   storageStreamIdleReadTimeout,
		OpenResponse:  storageHopClient.Do,
	})
	if err != nil {
		if errors.Is(err, outbound.ErrResourceTooLarge) {
			err = errors.New("媒体服务控制响应过大")
		}
		return "", "", 0, err
	}
	return res.Path, res.MimeType, res.Size, nil
}

func isRedirectStatus(code int) bool {
	return code == http.StatusMovedPermanently || code == http.StatusFound || code == http.StatusSeeOther || code == http.StatusTemporaryRedirect || code == http.StatusPermanentRedirect
}

func (c *MediaClient) Result(ctx context.Context, task MediaTask, legacy bool) (map[string]any, error) {
	if task.MediaType != "image" {
		return c.singleMediaResult(ctx, task)
	}
	items := make([]map[string]any, 0, len(task.Outputs))
	usage, metadata := task.Usage, task.Metadata
	if len(task.Outputs) == 0 && task.ResultReceipt != nil {
		if !legacy {
			return nil, errors.New("新媒体任务未返回可保存的图片链接")
		}
		data, err := c.storageJSON(ctx, *task.ResultReceipt)
		if err != nil {
			return nil, err
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw["data"], &items); err != nil {
			return nil, err
		}
		usage = raw["usage"]
		metadata = make(map[string]any)
		for key, value := range raw {
			if key == "data" || key == "usage" {
				continue
			}
			var decoded any
			if err := json.Unmarshal(value, &decoded); err != nil {
				return nil, err
			}
			metadata[key] = decoded
		}
	} else {
		for _, output := range task.Outputs {
			if output.Kind != "image" {
				return nil, errors.New("媒体结果类型不匹配")
			}
			if err := c.validURLContext(ctx, output.URL); err != nil {
				return nil, err
			}
			item := make(map[string]any, len(output.Metadata)+1)
			for key, value := range output.Metadata {
				item[key] = value
			}
			item["url"] = output.URL
			items = append(items, item)
		}
	}
	images := make([]map[string]string, 0, len(items))
	layers := make([]map[string]any, 0, len(items))
	hasLayer := false
	for index, item := range items {
		link, _ := item["url"].(string)
		if encoded, _ := item["b64_json"].(string); encoded != "" {
			data, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return nil, errors.New("历史图片结果编码无效")
			}
			mime := strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0])
			switch mime {
			case "image/png", "image/jpeg", "image/webp", "image/gif":
			default:
				return nil, errors.New("历史图片结果不是可识别的图片")
			}
			link = "data:" + mime + ";base64," + encoded
		} else if err := c.validURLContext(ctx, link); err != nil {
			return nil, err
		}
		if link == "" {
			return nil, errors.New("媒体结果缺少图片")
		}
		images = append(images, map[string]string{"dataUrl": link})
		layer := map[string]any{"imageIndex": index}
		for key, value := range item {
			if key != "url" && key != "b64_json" && key != "imageIndex" {
				layer[key] = value
				hasLayer = true
			}
		}
		layers = append(layers, layer)
	}
	if len(images) == 0 {
		return nil, errors.New("媒体任务未返回可保存的图片")
	}
	result := map[string]any{"mode": "image", "images": images}
	if hasLayer {
		result["imageLayers"] = layers
	}
	if len(metadata) > 0 {
		result["metadata"] = metadata
	}
	if len(usage) > 0 && string(usage) != "null" {
		var value any
		if err := json.Unmarshal(usage, &value); err != nil {
			return nil, err
		}
		result["usage"] = value
	}
	return result, nil
}

// Videos, speech and upscale return one owned storage URL. Local delivery owns
// downloading it; control-plane queries never proxy the media bytes.
func (c *MediaClient) singleMediaResult(ctx context.Context, task MediaTask) (map[string]any, error) {
	if task.TaskID != "" {
		c.LastTaskID = task.TaskID
	}
	if task.MediaType != "video" && task.MediaType != "audio" && task.MediaType != "upscale" {
		return nil, errors.New("媒体任务类型不受支持")
	}
	if len(task.Outputs) != 1 {
		return nil, errors.New("媒体任务未返回唯一可保存的结果")
	}
	output := task.Outputs[0]
	if task.MediaType == "upscale" {
		if output.Kind != "image" && output.Kind != "video" {
			return nil, errors.New("超分结果类型不匹配")
		}
		if c.ExpectedOutputKind != "" && output.Kind != c.ExpectedOutputKind {
			return nil, errors.New("超分结果与原素材类型不一致")
		}
	} else if output.Kind != task.MediaType {
		return nil, errors.New("媒体结果类型不匹配")
	}
	if err := c.validURLContext(ctx, output.URL); err != nil {
		return nil, err
	}
	item := map[string]any{"url": output.URL}
	for key, value := range output.Metadata {
		if key != "url" && key != "dataUrl" && key != "resourceId" && key != "storageKey" {
			item[key] = value
		}
	}
	result := map[string]any{"mode": output.Kind}
	if output.Kind == "image" {
		result["images"] = []map[string]any{item}
	} else {
		result[output.Kind] = item
	}
	if len(task.Metadata) > 0 {
		result["metadata"] = task.Metadata
	}
	if len(task.Usage) > 0 && string(task.Usage) != "null" {
		var usage any
		if err := json.Unmarshal(task.Usage, &usage); err != nil {
			return nil, err
		}
		result["usage"] = usage
	}
	return result, nil
}
