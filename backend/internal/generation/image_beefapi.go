package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/providerpreset"
)

// BeefAPIImageSettlement holds the raw settlement fields from GET /v1/images/jobs/{job_id}.
// HasBillingState distinguishes a response that explicitly returned `"billing_state": ""`
// (settlement pending) from a response that omitted `billing_state` entirely.
type BeefAPIImageSettlement struct {
	BillingState      *string
	ReconcileDeadline *string
	HasBillingState   bool
}

// ExtractBeefAPIImageJobID extracts BeefAPI's image job ID from X-Image-Job-Id header,
// Location: .../images/jobs/{job_id} header, or response/error body task_id / job_id.
func ExtractBeefAPIImageJobID(headers http.Header, body []byte) string {
	if headers != nil {
		if id := strings.TrimSpace(headers.Get("X-Image-Job-Id")); id != "" {
			return id
		}
		if loc := strings.TrimSpace(headers.Get("Location")); loc != "" {
			if idx := strings.Index(loc, "/images/jobs/"); idx >= 0 {
				rest := strings.TrimPrefix(loc[idx:], "/images/jobs/")
				if slash := strings.IndexByte(rest, '/'); slash >= 0 {
					rest = rest[:slash]
				}
				if q := strings.IndexByte(rest, '?'); q >= 0 {
					rest = rest[:q]
				}
				if id := strings.TrimSpace(rest); id != "" {
					return id
				}
			}
		}
	}
	if len(body) == 0 {
		return ""
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	dataMap, _ := payload["data"].(map[string]interface{})
	errMap, _ := payload["error"].(map[string]interface{})
	for _, m := range []map[string]interface{}{
		payload,
		dataMap,
		errMap,
	} {
		if m == nil {
			continue
		}
		for _, key := range []string{"task_id", "job_id"} {
			if val, ok := m[key].(string); ok {
				if trimmed := strings.TrimSpace(val); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}

// ExtractBeefAPIImageSettlement inspects the raw map from GET /v1/images/jobs/{job_id}.
// Only when the "billing_state" key is present in the JSON map (or nested data map)
// does it set HasBillingState = true and BillingState to the string value (including "").
func ExtractBeefAPIImageSettlement(state map[string]interface{}) BeefAPIImageSettlement {
	var out BeefAPIImageSettlement
	curr := state
	for curr != nil {
		if !out.HasBillingState {
			if raw, exists := curr["billing_state"]; exists {
				if v, ok := raw.(string); ok {
					trimmed := strings.TrimSpace(v)
					out.BillingState = &trimmed
					out.HasBillingState = true
				}
			}
		}
		if out.ReconcileDeadline == nil {
			if raw, exists := curr["reconcile_deadline"]; exists && raw != nil {
				if v, ok := raw.(string); ok {
					trimmed := strings.TrimSpace(v)
					out.ReconcileDeadline = &trimmed
				}
			}
		}
		nested, ok := curr["data"].(map[string]interface{})
		if !ok {
			break
		}
		curr = nested
	}
	return out
}

// QueryBeefAPIImageJob queries GET /v1/images/jobs/{job_id} and returns the raw
// settlement fields even if the job payload carries an error envelope.
func QueryBeefAPIImageJob(ctx context.Context, config Config, jobID string) (BeefAPIImageSettlement, map[string]interface{}, error) {
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return BeefAPIImageSettlement{}, nil, fmt.Errorf("图片任务缺少上游 job_id")
	}
	path := "/images/jobs/" + url.PathEscape(jobID)
	var state map[string]interface{}
	err := GetJSON(WithRequestKind(ctx, "poll"), config, path, &state)
	settlement := ExtractBeefAPIImageSettlement(state)
	if err != nil {
		if len(state) > 0 && (settlement.HasBillingState || settlement.ReconcileDeadline != nil) {
			return settlement, state, nil
		}
		return settlement, state, err
	}
	return settlement, state, nil
}

func runBeefAPIImageTask(ctx context.Context, input Input, contract providerpreset.ImageContract) (map[string]interface{}, error) {
	if input.Config.TransparentBackground == "true" {
		return nil, fmt.Errorf("当前图片模型不支持透明背景")
	}
	if err := modelcatalog.ValidateImageTask(nil, taskInputFromCanvas(input)); err != nil {
		return nil, err
	}
	if len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
		return nil, fmt.Errorf("当前图片模型不支持参考视频或音频")
	}
	size, err := contract.PixelSize(input.Config.Size)
	if err != nil {
		return nil, err
	}
	images := make([]string, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		if image.DataURL != "" || strings.HasPrefix(image.URL, "data:") {
			raw, mime, err := GeminiImageBytes(image)
			if err != nil {
				return nil, err
			}
			if int64(len(raw)) > contract.MaxImageBytes {
				return nil, fmt.Errorf("参考图片文件超过当前模型大小限制")
			}
			if mime != "image/png" && mime != "image/jpeg" {
				return nil, fmt.Errorf("当前图片模型仅支持 PNG 或 JPEG 参考图")
			}
			images = append(images, DataURL(mime, raw))
		} else {
			if image.URL == "" {
				return nil, fmt.Errorf("参考图片数据为空")
			}
			url, err := outbound.ValidateOutboundURL(image.URL)
			if err != nil || (url.Scheme != "https" && !BeefAPISeedanceAllowInsecureTestURL(ctx, url)) {
				return nil, fmt.Errorf("参考图片需要可访问的 HTTPS 链接")
			}
			images = append(images, image.URL)
		}
	}
	body := map[string]interface{}{"model": input.Config.Model, "prompt": WithSystemPrompt(input.Config, input.Prompt), "size": size}
	if isManagedImageURLConfig(ctx, input.Config) {
		body["response_format"] = "url"
	}
	if len(images) > 0 {
		body["images"] = images
	}
	var payload ImageResponse
	if err := PostJSON(ctx, input.Config, contract.Path, body, &payload); err != nil {
		return nil, err
	}
	output, err := MaterializeImageDataURLs(ctx, input.Config, payload)
	if err != nil {
		return nil, err
	}
	result := map[string]interface{}{"mode": "image", "images": output}
	if payload.Usage != nil {
		result["usage"] = payload.Usage
	}
	return result, nil
}
