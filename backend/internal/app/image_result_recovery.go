package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"

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
	ctx = withProviderRequestKind(withProviderAnalytics(ctx, s, task), "poll")
	receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	result, handled, receiptErr := imageResultFromReceiptContext(ctx, receipt)
	if receiptErr != nil || !handled {
		jobResult, jobHandled, jobErr := s.imageJobResult(ctx, task)
		if jobHandled {
			result, handled, receiptErr = jobResult, true, jobErr
		} else if receiptErr != nil {
			return nil, true, receiptErr
		} else {
			result, handled, receiptErr = nil, false, nil
		}
	}
	if !handled || receiptErr != nil {
		return nil, handled, receiptErr
	}
	if len(result) == 0 {
		// A known job that is still running is handled so /retry cannot turn
		// the pending provider request into a second paid submission.
		return taskForOutput(task), true, nil
	}
	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, task.UserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		return nil, true, err
	}
	task.LeaseOwner = owner
	defer s.repo.ReleaseTaskProviderRecovery(task.ID, owner)
	task.Error = ""
	task.FailureDiagnostics = nil
	if err := s.saveTaskCompletionWithinStorageQuota(&task, result, nil, false); err != nil {
		return nil, true, err
	}
	_ = s.log(task.UserID, task.ID, "info", "已从原始成功响应恢复图片，等待取回结果", receipt.ID)
	s.attachTaskDelivery(&task)
	return taskForOutput(task), true, nil
}

// 人工 /retry 与自动扫描共用相同的回执有效性检查。
func (s *Service) imageJobResult(ctx context.Context, task model.Task) ([]byte, bool, error) {
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
	err = getJSON(ctx, config, path, &payload)
	s.captureTaskBillingEvidence(&task)
	if err != nil {
		return nil, true, imageRecoveryError{err}
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
		return nil, true, imageRecoveryError{errors.New("图片任务未能生成结果")}
	}
	data := imageJobData(payload)
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
	if testOrigin := strings.TrimRight(strings.TrimSpace(os.Getenv("BEEFTV_ENTERPRISE_TEST_ORIGIN")), "/"); testOrigin != "" && baseURL == testOrigin {
		return true
	}
	parsed, err := url.Parse(baseURL)
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
