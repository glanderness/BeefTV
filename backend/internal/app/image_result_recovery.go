package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

// Old image tasks could fail while downloading after a successful create.
// Restore only an exact, complete image receipt or the formal gateway's
// asynchronous job result. Never submit a POST.
func (s *Service) recoverAcceptedImage(task model.Task) (*model.Task, bool, error) {
	return s.recoverAcceptedImageContext(context.Background(), task)
}

func (s *Service) recoverAcceptedImageContext(ctx context.Context, task model.Task) (*model.Task, bool, error) {
	if task.Type != "canvas_image" || task.Status != model.TaskStatusFailed {
		return nil, false, nil
	}
	receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	jobID, err := s.repo.LatestBeefAPIImageJobIDForTask(task)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	if jobID == "" && (receipt == nil || receipt.StatusCode >= 300) {
		return nil, false, nil
	}
	if jobID == "" {
		// Keep the legacy /retry error for incomplete or ambiguous receipts;
		// an HTTP acceptance without a result must not look like a new retry.
		if _, handled, receiptErr := imageResultFromReceiptContext(ctx, receipt); !handled || receiptErr != nil {
			return nil, handled, receiptErr
		}
	}
	if err := s.recoverFailedImage(ctx, task); err != nil {
		return nil, true, err
	}
	current, err := s.Task(task.UserID, task.ID)
	return current, true, err
}

// 人工 /retry 与自动扫描共用相同的回执有效性检查。
func (s *Service) imageJobResult(ctx context.Context, task model.Task) ([]byte, bool, error) {
	return s.imageJobResultWithMode(ctx, task, false)
}

func (s *Service) imageJobResultWithMode(ctx context.Context, task model.Task, billingOnly bool) ([]byte, bool, error) {
	ctx = withProviderRequestKind(withProviderAnalytics(ctx, s, task), "poll")
	jobID, err := s.repo.LatestBeefAPIImageJobIDForTask(task)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return nil, false, nil
	}
	decrypted, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, true, err
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(decrypted), &input); err != nil {
		return nil, true, err
	}
	config, err := s.resolveProviderConfig(input.Config)
	if err != nil {
		return nil, true, err
	}
	path := "/v1/images/jobs/" + url.PathEscape(strings.TrimSpace(jobID))
	if !isBeefAPIImageRecoveryConfig(config) {
		return nil, true, imageRecoveryError{errors.New("图片任务查询协议不受支持")}
	}
	var payload map[string]any
	started := time.Now()
	err = getJSON(ctx, config, path, &payload)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	if returned, ok := payload["job_id"].(string); ok && returned != jobID {
		return nil, true, imageRecoveryError{errors.New("上游返回的任务与原图片任务不一致")}
	}
	if err := s.observeTaskBilling(task, config, jobID, payload, started); err != nil {
		return nil, true, err
	}
	if billingOnly {
		return nil, true, nil
	}
	status := imageJobStatus(payload)
	switch status {
	case "", "queued", "pending", "running", "processing", "in_progress", "submitted":
		if status == "" && imageJobData(payload) == nil {
			return nil, true, imageRecoveryError{errors.New("图片任务状态缺少结果")}
		}
		if status != "" {
			return nil, true, nil
		}
	case "failed", "error", "cancelled", "canceled", "expired":
		outcome := "no_result"
		if status == "expired" {
			outcome = "unrecoverable"
		}
		return nil, true, originalResultConclusion{outcome}
	}
	data := imageJobData(payload)
	if data == nil && strings.TrimSpace(stringValue(payload["result_url"])) != "" {
		var result map[string]any
		if err := getJSON(ctx, config, path+"/result", &result); err != nil {
			var upstream providerHTTPError
			if errors.As(err, &upstream) && upstream.StatusCode == http.StatusGone {
				return nil, true, originalResultConclusion{"unrecoverable"}
			}
			return nil, true, imageRecoveryError{err}
		}
		data = imageJobData(result)
	}
	if data == nil {
		return nil, true, imageRecoveryError{errors.New("图片任务结果缺少图片数据")}
	}
	imagePayload := generation.ImageResponse{Data: data}
	images, err := generation.MaterializeImageDataURLs(ctx, config, imagePayload)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	result, err := json.Marshal(map[string]any{"mode": "image", "images": images})
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	return result, true, nil
}

func isBeefAPIImageRecoveryConfig(config providerConfig) bool {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if testOrigin := strings.TrimRight(strings.TrimSpace(os.Getenv("BEEFTV_ENTERPRISE_TEST_ORIGIN")), "/"); testOrigin != "" && err == nil && parsed.Scheme+"://"+parsed.Host == testOrigin {
		return true
	}
	return beefapi.IsManagedChannel(config.ChannelID, "", config.BaseURL) || (err == nil && parsed.Hostname() != "" && generation.IsBeefAPIHost(parsed.Hostname()))
}

func imageJobStatus(payload map[string]any) string {
	for _, key := range []string{"status", "state", "task_status", "taskStatus"} {
		if value, ok := payload[key].(string); ok {
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return ""
}

func imageJobData(payload map[string]any) []map[string]interface{} {
	candidates := []any{payload["data"], payload["images"], payload["result"], payload["output"]}
	for _, candidate := range candidates {
		switch value := candidate.(type) {
		case string:
			if strings.TrimSpace(value) != "" {
				return []map[string]interface{}{{"url": value}}
			}
		case []any:
			encoded, err := json.Marshal(value)
			if err != nil {
				continue
			}
			var data []map[string]interface{}
			if json.Unmarshal(encoded, &data) == nil && len(data) > 0 {
				return data
			}
		case map[string]any:
			if _, ok := value["url"]; ok {
				return []map[string]interface{}{value}
			}
			if _, ok := value["b64_json"]; ok {
				return []map[string]interface{}{value}
			}
			if nested := imageJobData(value); nested != nil {
				return nested
			}
		}
	}
	return nil
}

func imageResultFromReceipt(receipt *model.ApiCallLog) ([]byte, bool, error) {
	return imageResultFromReceiptContext(context.Background(), receipt)
}

func imageResultFromReceiptContext(ctx context.Context, receipt *model.ApiCallLog) ([]byte, bool, error) {
	if receipt != nil && (receipt.StatusCode < 200 || (receipt.StatusCode >= 200 && receipt.StatusCode < 300 && (receipt.StatusCode != 200 || receipt.Status != model.ApiCallStatusSucceeded || receipt.APIFormat != "openai" || (!strings.HasSuffix(receipt.Path, "/images/generations") && !strings.HasSuffix(receipt.Path, "/images/edits"))))) {
		return nil, true, imageRecoveryError{errors.New("创建请求结果未知")}
	}
	if receipt == nil || receipt.StatusCode < 200 || receipt.StatusCode >= 300 {
		return nil, false, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(receipt.ResponseBody), &payload); err != nil {
		return nil, true, imageRecoveryError{err}
	}
	if _, _, failed := generation.PayloadBusinessFailure(payload); failed {
		return nil, false, nil
	}
	var body struct {
		Error json.RawMessage `json:"error"`
		Data  []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(receipt.ResponseBody), &body); err != nil || len(body.Data) == 0 || (len(body.Error) > 0 && string(body.Error) != "null") {
		return nil, true, imageRecoveryError{errors.New("成功回执缺少完整图片结果")}
	}
	images := make([]map[string]any, 0, len(body.Data))
	for _, image := range body.Data {
		if _, err := outbound.ValidateOutboundURLContext(ctx, image.URL); err != nil {
			return nil, true, err
		}
		images = append(images, map[string]any{"url": image.URL})
	}
	result, err := json.Marshal(map[string]any{"mode": "image", "images": images})
	if err != nil {
		return nil, true, err
	}
	return result, true, nil
}
