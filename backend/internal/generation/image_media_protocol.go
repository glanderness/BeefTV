package generation

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/outbound"
)

const ImageMediaProtocolHeader = "X-BeefAPI-Image-Media-Protocol"
const ImageMediaProtocol = "direct-media-v1"

type imageMediaContext struct{}
type imageMediaRequiredContext struct{}

func managedImageConnection(config Config) bool {
	return config.CredentialRef == beefapi.CredentialRef
}

func directImageMedia(ctx context.Context) bool {
	version, _ := ctx.Value(imageMediaContext{}).(string)
	return version == ImageMediaProtocol
}

// Negotiate before reading local references. Only a managed credential opts in;
// the same hostname in a custom connection does not change that connection.
func negotiateManagedImageMedia(ctx context.Context, config Config) (context.Context, error) {
	if !managedImageConnection(config) || directImageMedia(ctx) {
		return ctx, nil
	}
	ctx = context.WithValue(ctx, imageMediaRequiredContext{}, config.BaseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, APIURL(config.BaseURL, "/images/generations"), nil)
	if err == nil {
		ApplyAuth(req, config)
		outbound.ApplyOutboundHeaders(req, config.Headers)
		req.Header.Del(ImageMediaProtocolHeader)
		req, err = NegotiateImageReplay(req)
	}
	if err != nil {
		return ctx, RequestPreparationError{Cause: err}
	}
	if !directImageMedia(req.Context()) {
		return ctx, RequestPreparationError{Cause: errors.New("图片服务暂不支持直接传输素材，本次尚未开始生成，请稍后重试")}
	}
	return req.Context(), nil
}

func imageMediaProbe(req *http.Request) bool {
	if req == nil || req.URL == nil {
		return false
	}
	base, _ := req.Context().Value(imageMediaRequiredContext{}).(string)
	return base != "" && SameProviderOrigin(base, req.URL.String()) && BeefAPISeedanceAllowInsecureTestURL(req.Context(), req.URL)
}

func imageGenerationRequest(req *http.Request) bool {
	return req != nil && req.URL != nil && req.Method == http.MethodPost && (strings.HasSuffix(req.URL.Path, "/images/generations") || strings.HasSuffix(req.URL.Path, "/images/edits"))
}

func applyImageMediaHeader(req *http.Request) {
	if !imageGenerationRequest(req) || !directImageMedia(req.Context()) {
		return
	}
	base, _ := req.Context().Value(imageMediaRequiredContext{}).(string)
	if SameProviderOrigin(base, req.URL.String()) {
		req.Header.Set(ImageMediaProtocolHeader, ImageMediaProtocol)
	}
}

// The negotiated gateway owns response delivery. Strip plugin/cached format
// choices at the last serialization point, without changing business options.
func directImageBody(ctx context.Context, rawURL string, value any) (any, error) {
	if !directImageMedia(ctx) {
		return value, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || !(strings.HasSuffix(u.Path, "/images/generations") || strings.HasSuffix(u.Path, "/images/edits")) {
		return value, nil
	}
	body, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("图片请求格式无效，本次尚未开始生成")
	}
	next := make(map[string]any, len(body))
	for key, item := range body {
		if key != "response_format" {
			next[key] = item
		}
	}
	for _, key := range []string{"image", "images", "mask"} {
		if item, exists := next[key]; exists {
			if !directImageReferences(ctx, item) {
				return nil, errors.New("参考图片尚未直接上传完成，本次尚未开始生成")
			}
			if key == "mask" {
				if _, ok := item.(string); !ok {
					return nil, errors.New("蒙版链接格式无效，本次尚未开始生成")
				}
				continue
			}
			if link, ok := item.(string); ok {
				item = []string{link}
			}
			next["image"] = item
			if key == "images" {
				delete(next, key)
			}
		}
	}
	return next, nil
}

func directImageReferences(ctx context.Context, value any) bool {
	switch item := value.(type) {
	case string:
		parsed, err := url.Parse(item)
		return err == nil && parsed.Hostname() != "" && parsed.User == nil && (parsed.Scheme == "https" || BeefAPISeedanceAllowInsecureTestURL(ctx, parsed))
	case []string:
		for _, link := range item {
			if !directImageReferences(ctx, link) {
				return false
			}
		}
		return len(item) > 0
	case []any:
		for _, link := range item {
			if _, ok := link.(string); !ok || !directImageReferences(ctx, link) {
				return false
			}
		}
		return len(item) > 0
	default:
		return false
	}
}
