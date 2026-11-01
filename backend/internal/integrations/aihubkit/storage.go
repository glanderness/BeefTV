package aihubkit

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

type uploadTicket struct {
	UploadURL   string            `json:"upload_url"`
	URL         string            `json:"url"`
	Key         string            `json:"key"`
	ExpiresIn   int64             `json:"expires_in"`
	ContentType string            `json:"content_type"`
	Headers     map[string]string `json:"headers"`
}

// upload accepts any file MIME type. Both ticket creation and raw PUT happen
// during execution, so queued tasks never store expiring signed URLs.
func (c *client) upload(ctx context.Context, token, filename, contentType string, size int64, body io.Reader) (link string, expiresAt time.Time, err error) {
	if token == "" || size <= 0 || filename == "" || contentType == "" {
		return "", time.Time{}, errors.New("上传文件信息不完整")
	}
	issued := time.Now()
	var ticket uploadTicket
	if err := c.call(ctx, "POST", "/v1/temporary-files", map[string]any{"filename": filepath.Base(filename), "content_type": contentType, "size": size}, token, 0, &ticket); err != nil {
		return "", time.Time{}, err
	}
	if ticket.ExpiresIn <= 0 || ticket.ExpiresIn > int64((1<<63-1)/time.Second) {
		return "", time.Time{}, errors.New("临时文件有效期无效")
	}
	if _, err := outbound.ValidatePublicHTTPSURLContext(ctx, ticket.UploadURL); err != nil {
		return "", time.Time{}, errors.New("文件上传地址无效")
	}
	if _, err := outbound.ValidatePublicHTTPSURLContext(ctx, ticket.URL); err != nil {
		return "", time.Time{}, errors.New("文件访问地址无效")
	}
	// The deadline includes ticket acquisition, DNS validation and PUT. No
	// management credential or dashboard cookie is sent to the object store.
	deadline := issued.Add(time.Duration(ticket.ExpiresIn) * time.Second)
	uploadCtx, cancel := context.WithDeadline(outbound.WithPublicHTTPS(ctx), deadline)
	defer cancel()
	r, err := http.NewRequestWithContext(uploadCtx, http.MethodPut, ticket.UploadURL, body)
	if err != nil {
		return "", time.Time{}, errors.New("文件上传请求无效")
	}
	r.ContentLength = size
	for name, value := range ticket.Headers {
		lower := strings.ToLower(name)
		if !strings.HasPrefix(lower, "x-amz-") && lower != "content-type" && lower != "content-md5" && lower != "cache-control" && lower != "content-disposition" {
			return "", time.Time{}, errors.New("文件上传响应包含不支持的请求头")
		}
		if strings.ContainsAny(name+value, "\r\n") {
			return "", time.Time{}, errors.New("文件上传请求头无效")
		}
		r.Header.Set(name, value)
	}
	if r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", contentType)
	}
	resp, err := c.uploadHTTP.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return "", time.Time{}, ctx.Err()
		}
		return "", time.Time{}, errors.New("文件上传失败或链接已过期，请重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", time.Time{}, errors.New("文件存储拒绝上传，请重试")
	}
	if time.Until(deadline) < 5*time.Second {
		return "", time.Time{}, errors.New("文件访问链接即将过期，请重试")
	}
	return ticket.URL, deadline, nil
}
