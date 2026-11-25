package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/operations"
)

const (
	assistantBusinessMaxUploadBytes   = 16 << 20 // 16 MiB base64 upload cap
	assistantBusinessMaxResponseBytes = 4 << 20  // 4 MiB in-memory response cap
	assistantBusinessDefaultTimeout   = 30 * time.Second
)

var errBusinessResponseTooLarge = errors.New("business response exceeds limit")

type localBusinessGateway struct {
	handler http.Handler
	catalog *BusinessCatalog
}

// NewBusinessGateway builds an in-process gateway backed by the mounted Gin
// router and audited BusinessCatalog allowlist.
func NewBusinessGateway(h http.Handler, catalog *BusinessCatalog) operations.BusinessGateway {
	if h == nil || catalog == nil {
		return nil
	}
	return &localBusinessGateway{handler: h, catalog: catalog}
}

func (g *localBusinessGateway) ListBusinessTools(query, method string, readOnlyOnly bool, offset, limit int) ([]operations.BusinessCatalogItem, int) {
	q := strings.ToLower(strings.TrimSpace(query))
	m := strings.ToUpper(strings.TrimSpace(method))
	matched := make([]operations.BusinessCatalogItem, 0, len(g.catalog.Tools))
	for _, tool := range g.catalog.Tools {
		if readOnlyOnly && !tool.ReadOnly {
			continue
		}
		if m != "" && !strings.EqualFold(tool.Method, m) {
			continue
		}
		if q != "" {
			haystack := strings.ToLower(tool.ID + " " + tool.Method + " " + tool.Path + " " + tool.Summary)
			if !strings.Contains(haystack, q) {
				continue
			}
		}
		summary := tool.Summary
		if _, _, blockMsg, blocked := tool.AssistantBlockPolicy(); blocked {
			summary = tool.Method + " " + tool.Path + "（不可通过 business.call 调用：" + blockMsg + "）"
		}
		matched = append(matched, operations.BusinessCatalogItem{
			ID:                tool.ID,
			Summary:           summary,
			Method:            tool.Method,
			Path:              tool.Path,
			ReadOnly:          tool.ReadOnly,
			SubmitsGeneration: tool.SubmitsGeneration,
			Params:            tool.Params,
		})
	}
	total := len(matched)
	if offset >= total {
		return []operations.BusinessCatalogItem{}, total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return matched[offset:end], total
}

func (g *localBusinessGateway) CallBusinessTool(ctx context.Context, _ string, req operations.BusinessCallRequest) (any, error) {
	var found *BusinessTool
	for i := range g.catalog.Tools {
		if g.catalog.Tools[i].ID == req.Tool {
			found = &g.catalog.Tools[i]
			break
		}
	}
	if found == nil {
		return nil, operations.NotFound("business_tool_not_found", "未找到工作区接口: "+req.Tool)
	}
	if kind, reason, msg, blocked := found.AssistantBlockPolicy(); blocked {
		if kind == "invalid" {
			return nil, operations.InvalidArg(reason, msg)
		}
		return nil, operations.PermissionDenied(reason, msg)
	}

	targetPath, err := substituteBusinessPath(found.Path, req.Path)
	if err != nil {
		return nil, err
	}
	query := url.Values{}
	for k, v := range req.Query {
		query.Set(k, v)
	}
	fullURL := "/api" + targetPath
	if encoded := query.Encode(); encoded != "" {
		fullURL += "?" + encoded
	}

	var bodyReader io.Reader
	contentType := "application/json"
	if req.File != nil {
		if !(found.Method == http.MethodPost && (found.Path == "/resources" || found.Path == "/skills/install" || found.Path == "/plugins")) {
			return nil, operations.InvalidArg("upload_not_supported", "该接口不支持文件上传")
		}
		decoded, err := base64.StdEncoding.DecodeString(req.File.Data)
		if err != nil {
			return nil, operations.InvalidArg("invalid_file_data", "文件 Base64 编码无效")
		}
		if len(decoded) > assistantBusinessMaxUploadBytes {
			return nil, operations.InvalidArg("file_too_large", fmt.Sprintf("单次内联上传不能超过 %dMB", assistantBusinessMaxUploadBytes>>20))
		}
		name := filepath.Base(strings.TrimSpace(req.File.Name))
		if name == "" || name == "." || name == "/" {
			return nil, operations.InvalidArg("invalid_file_name", "文件名必填")
		}
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		part, err := mw.CreateFormFile("file", name)
		if err != nil {
			return nil, operations.AsError(err)
		}
		if _, err := part.Write(decoded); err != nil {
			return nil, operations.AsError(err)
		}
		if len(bytes.TrimSpace(req.Body)) > 0 {
			fields := map[string]any{}
			if err := json.Unmarshal(req.Body, &fields); err != nil {
				return nil, operations.InvalidArg("invalid_params", "文件上传附带 body 必须是 JSON 对象")
			}
			for key, value := range fields {
				if err := mw.WriteField(key, fmt.Sprint(value)); err != nil {
					return nil, operations.AsError(err)
				}
			}
		}
		if err := mw.Close(); err != nil {
			return nil, operations.AsError(err)
		}
		bodyReader = &buf
		contentType = mw.FormDataContentType()
	} else if len(bytes.TrimSpace(req.Body)) > 0 {
		bodyReader = bytes.NewReader(req.Body)
	}

	if ctx == nil {
		ctx = context.Background()
	}
	var cancel context.CancelFunc
	if _, hasDeadline := ctx.Deadline(); hasDeadline {
		ctx, cancel = context.WithCancel(ctx)
	} else {
		ctx, cancel = context.WithTimeout(ctx, assistantBusinessDefaultTimeout)
	}
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, found.Method, "http://127.0.0.1"+fullURL, bodyReader)
	if err != nil {
		return nil, operations.AsError(err)
	}
	httpReq.RemoteAddr = "127.0.0.1:0"
	httpReq.Host = "127.0.0.1"
	if bodyReader != nil {
		httpReq.Header.Set("Content-Type", contentType)
	}
	if req.OperationID != "" {
		httpReq.Header.Set("X-Idempotency-Key", req.OperationID)
	}
	httpReq = WithExternalBusinessPrincipal(httpReq, false)

	rec := newBoundedResponseWriter(assistantBusinessMaxResponseBytes, cancel)
	g.handler.ServeHTTP(rec, httpReq)
	if rec.overflow {
		return nil, operations.PreconditionFailed("business_response_too_large", "接口返回内容过大，请加分页或筛选参数后重试", nil)
	}

	statusCode := rec.statusCode()
	raw := rec.buf.Bytes()
	respCT := strings.ToLower(strings.TrimSpace(rec.header.Get("Content-Type")))
	if !strings.Contains(respCT, "application/json") {
		if statusCode < 200 || statusCode >= 300 {
			return nil, mapBusinessHTTPStatus(statusCode, "", strings.TrimSpace(string(raw)), nil)
		}
		return map[string]any{
			"tool":     found.ID,
			"status":   statusCode,
			"mimeType": rec.header.Get("Content-Type"),
			"bytes":    len(raw),
			"note":     "二进制内容不直接内联返回；文本/文档请用 file_read，媒体请用 media_overview/media_inspect。",
		}, nil
	}

	var envelope struct {
		Code    int            `json:"code"`
		Data    any            `json:"data"`
		Msg     string         `json:"msg"`
		Reason  string         `json:"reason"`
		Details map[string]any `json:"details"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		if statusCode < 200 || statusCode >= 300 {
			return nil, mapBusinessHTTPStatus(statusCode, "", strings.TrimSpace(string(raw)), nil)
		}
		return map[string]any{"tool": found.ID, "status": statusCode, "body": string(raw)}, nil
	}
	if statusCode < 200 || statusCode >= 300 || envelope.Code != 0 {
		status := statusCode
		if status >= 200 && status < 300 && envelope.Code >= 400 {
			status = envelope.Code
		}
		return nil, mapBusinessHTTPStatus(status, envelope.Reason, envelope.Msg, envelope.Details)
	}
	return map[string]any{
		"tool":   found.ID,
		"method": found.Method,
		"path":   found.Path,
		"data":   envelope.Data,
	}, nil
}

func substituteBusinessPath(template string, params map[string]string) (string, error) {
	parts := strings.Split(template, "/")
	for i, segment := range parts {
		if strings.HasPrefix(segment, ":") {
			key := segment[1:]
			value := ""
			if params != nil {
				value = params[key]
			}
			if value == "" || value == "." || value == ".." || strings.ContainsAny(value, "/\\%?#") {
				return "", operations.InvalidArg("invalid_path_param", "路径参数无效: "+key)
			}
			parts[i] = url.PathEscape(value)
		} else if strings.HasPrefix(segment, "*") {
			key := segment[1:]
			value := ""
			if params != nil {
				value = strings.TrimPrefix(params[key], "/")
			}
			if value == "" || strings.ContainsAny(value, "\\%?#") {
				return "", operations.InvalidArg("invalid_path_param", "路径参数无效: "+key)
			}
			subParts := strings.Split(value, "/")
			escaped := make([]string, 0, len(subParts))
			for _, sub := range subParts {
				if sub == "" || sub == "." || sub == ".." {
					return "", operations.InvalidArg("invalid_path_param", "路径参数无效: "+key)
				}
				escaped = append(escaped, url.PathEscape(sub))
			}
			parts[i] = strings.Join(escaped, "/")
		}
	}
	return strings.Join(parts, "/"), nil
}

// boundedResponseWriter caps in-process response buffering so a single
// business.call cannot allocate unbounded RAM, and deliberately omits
// http.Flusher so streaming handlers cannot hang.
type boundedResponseWriter struct {
	header      http.Header
	status      int
	wroteHeader bool
	buf         bytes.Buffer
	limit       int
	overflow    bool
	cancel      context.CancelFunc
}

func newBoundedResponseWriter(limit int, cancel context.CancelFunc) *boundedResponseWriter {
	return &boundedResponseWriter{
		header: make(http.Header),
		limit:  limit,
		cancel: cancel,
	}
}

func (w *boundedResponseWriter) Header() http.Header { return w.header }

func (w *boundedResponseWriter) WriteHeader(code int) {
	if w.wroteHeader {
		return
	}
	w.status = code
	w.wroteHeader = true
}

func (w *boundedResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.overflow {
		return 0, errBusinessResponseTooLarge
	}
	if w.buf.Len()+len(p) > w.limit {
		w.overflow = true
		if w.cancel != nil {
			w.cancel()
		}
		return 0, errBusinessResponseTooLarge
	}
	return w.buf.Write(p)
}

func (w *boundedResponseWriter) statusCode() int {
	if !w.wroteHeader {
		return http.StatusOK
	}
	return w.status
}

func mapBusinessHTTPStatus(status int, reason, msg string, details map[string]any) error {
	if strings.TrimSpace(reason) == "" {
		reason = fmt.Sprintf("business_http_%d", status)
	}
	if strings.TrimSpace(msg) == "" {
		msg = fmt.Sprintf("工作区接口返回错误 (%d)", status)
	}
	switch status {
	case http.StatusBadRequest:
		return operations.InvalidArg(reason, msg)
	case http.StatusForbidden, http.StatusUnauthorized:
		return operations.PermissionDenied(reason, msg)
	case http.StatusNotFound:
		return operations.NotFound(reason, msg)
	case http.StatusConflict:
		return operations.Conflict(reason, msg, details)
	default:
		return operations.PreconditionFailed(reason, msg, details)
	}
}
