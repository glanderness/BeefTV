package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/provider/comfyui"
)

const (
	maxNativeComfyNodes       = 500
	maxNativeComfyUploadBytes = 128 << 20
	maxNativeComfyBodyBytes   = 256 << 20
	maxNativeComfyJSONBytes   = 64 << 20
	nativeComfyUploadFolder   = "beeftv"
)

var errNativeComfyNotQueued = errors.New("not queued")

// ValidateNativeComfyConfig 校验候选适配器输入，不改变宿主的渠道准入规则。
func ValidateNativeComfyConfig(mode string, config Config) error {
	interfaceType := strings.ToLower(strings.TrimSpace(config.InterfaceType))
	if (mode != "image" && mode != "video" && mode != "audio") || interfaceType != "comfyui-"+mode {
		return errf("接口类型 %s 不支持%s生成", config.InterfaceType, mode)
	}
	if _, err := comfyui.ValidateURL(config.BaseURL); err != nil {
		return err
	}
	authType := strings.ToLower(strings.TrimSpace(config.AuthType))
	if authType == "" {
		authType = "none"
	}
	if authType != "none" && authType != "bearer" && authType != "header" {
		return errText("请选择 ComfyUI 鉴权方式")
	}
	if authType != "none" && strings.TrimSpace(config.APIKey) == "" {
		return errText("请填写 ComfyUI 密钥")
	}
	if authType == "header" && strings.TrimSpace(config.AuthHeader) == "" {
		return errText("请填写 ComfyUI 鉴权请求头名称")
	}
	workflowConfig := config.ComfyUI
	if workflowConfig == nil || len(workflowConfig.Graph) == 0 || len(workflowConfig.Graph) > maxNativeComfyNodes {
		return errf("请导入 API 格式 ComfyUI 工作流（最多 %d 个节点）", maxNativeComfyNodes)
	}
	for nodeID, raw := range workflowConfig.Graph {
		node, ok := raw.(map[string]any)
		if !ok {
			return errf("ComfyUI 节点 %s 不是 API 格式对象", nodeID)
		}
		classType, _ := node["class_type"].(string)
		if strings.TrimSpace(classType) == "" {
			return errf("ComfyUI 节点 %s 缺少 class_type", nodeID)
		}
		if _, ok := node["inputs"].(map[string]any); !ok {
			return errf("ComfyUI 节点 %s 缺少 inputs", nodeID)
		}
	}
	if workflowConfig.OutputNodeID == "" {
		return errText("请选择 ComfyUI 输出节点")
	}
	if _, ok := workflowConfig.Graph[workflowConfig.OutputNodeID]; !ok {
		return errText("ComfyUI 输出节点不存在")
	}
	switch workflowConfig.OutputField {
	case "images", "gifs", "videos", "audio":
	default:
		return errText("请选择 ComfyUI 输出字段")
	}
	return validateNativeComfyFields(workflowConfig)
}

func validateNativeComfyFields(config *ComfyWorkflow) error {
	for _, field := range config.Fields {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		if strings.TrimSpace(field.NodeID) == "" || strings.TrimSpace(field.FieldName) == "" {
			return errText("ComfyUI 字段映射缺少节点或输入名")
		}
		node, ok := config.Graph[field.NodeID].(map[string]any)
		if !ok {
			return errf("ComfyUI 字段映射的节点 %s 不存在", field.NodeID)
		}
		inputs, ok := node["inputs"].(map[string]any)
		if !ok {
			return errf("ComfyUI 节点 %s 缺少输入定义", field.NodeID)
		}
		value, exists := inputs[field.FieldName]
		if !exists || isWorkflowLinkValue(value) {
			return errf("ComfyUI 字段 %s.%s 不存在或已是连线", field.NodeID, field.FieldName)
		}
	}
	return nil
}

// RunNativeComfy submits or resumes one native ComfyUI prompt.
func (c *Client) RunNativeComfy(ctx context.Context, input Input) (map[string]interface{}, error) {
	exec := c.prepared()
	input = nativeComfyMediaIdentities(input)
	config := input.Config
	if config.ComfyUI != nil {
		copied := config
		copied.WorkflowJSON = config.ComfyUI.Graph
		copied.WorkflowFields = config.ComfyUI.Fields
		config = copied
		input.Config = copied
	}
	if err := ValidateNativeComfyConfig(input.Mode, config); err != nil {
		return nil, err
	}
	if !input.LocalWorkspace {
		return nil, errors.New("原生 ComfyUI 仅支持本地工作区的已归属素材")
	}
	if strings.TrimSpace(input.ResumedRequestID) != "" {
		if exec.Requests == nil {
			return nil, errors.New("ComfyUI 缺少受保护的请求执行端口")
		}
		return exec.pollNativeComfy(ctx, config, input, strings.TrimSpace(input.ResumedRequestID))
	}
	if exec.Requests == nil || exec.Media == nil || exec.Receipt == nil {
		return nil, errors.New("ComfyUI 缺少受保护的执行、素材或回执端口")
	}
	if err := exec.Receipt.Ready(ctx); err != nil {
		return nil, err
	}
	nodes, err := exec.objectInfo(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := validateNativeComfyTarget(config.ComfyUI.Graph, config.ComfyUI.Fields, nodes); err != nil {
		return nil, err
	}
	files := map[string]string{}
	for _, media := range input.ReferenceImages {
		name, uploadErr := exec.uploadNativeComfyFile(ctx, config, media, "参考图片")
		if uploadErr != nil {
			return nil, uploadErr
		}
		files[nativeComfyMediaID(media, "reference-image", len(files))] = name
	}
	for _, media := range input.ReferenceVideos {
		name, uploadErr := exec.uploadNativeComfyFile(ctx, config, media, "参考视频")
		if uploadErr != nil {
			return nil, uploadErr
		}
		files[nativeComfyMediaID(media, "reference-video", len(files))] = name
	}
	for _, media := range input.ReferenceAudios {
		name, uploadErr := exec.uploadNativeComfyFile(ctx, config, media, "参考音频")
		if uploadErr != nil {
			return nil, uploadErr
		}
		files[nativeComfyMediaID(media, "reference-audio", len(files))] = name
	}
	if input.Mask != nil {
		name, uploadErr := exec.uploadNativeComfyFile(ctx, config, *input.Mask, "蒙版")
		if uploadErr != nil {
			return nil, uploadErr
		}
		files[nativeComfyMediaID(*input.Mask, "mask", len(files))] = name
	}
	bound, err := BindAPIGraph(input, files)
	if err != nil {
		return nil, err
	}
	if err := validateNativeComfyTarget(bound, config.ComfyUI.Fields, nodes); err != nil {
		return nil, err
	}
	clientID := strings.TrimSpace(input.ClientID)
	if clientID == "" {
		clientID = "beeftv-" + uuid.NewString()
	}
	body, err := json.Marshal(map[string]any{"prompt": bound, "client_id": clientID})
	if err != nil {
		return nil, err
	}
	response, err := exec.nativeComfyJSON(ctx, config, "create", http.MethodPost, "/prompt", body, "application/json", maxNativeComfyJSONBytes)
	if err != nil {
		if nativeComfyDefiniteCreateFailure(err) {
			return nil, fmt.Errorf("ComfyUI 工作流校验失败：%w", err)
		}
		return nil, CreateUncertain{Err: fmt.Errorf("ComfyUI 提交结果尚未确认：%w", err)}
	}
	promptID := strings.TrimSpace(comfyString(response, "prompt_id"))
	if promptID == "" {
		if response["error"] != nil || response["node_errors"] != nil {
			return nil, errors.New("ComfyUI 工作流校验失败，请检查节点、模型和输入")
		}
		return nil, CreateUncertain{Err: errors.New("ComfyUI 未返回 prompt_id")}
	}
	if err := exec.Receipt.RecordAccepted(ctx, promptID, "submitted", nil); err != nil {
		exec.Progress.Log(ctx, "error", "ComfyUI 受理回执保存失败", promptID+":"+err.Error())
		return nil, AcceptedNotRecorded{RequestID: promptID, Stage: "submitted", Err: err}
	}
	return exec.pollNativeComfy(ctx, config, input, promptID)
}

func nativeComfyMediaID(media Media, fallback string, index int) string {
	if id := strings.TrimSpace(media.ID); id != "" {
		return id
	}
	return fmt.Sprintf("%s-%d", fallback, index)
}

func nativeComfyMediaIdentities(input Input) Input {
	normalize := func(items []Media, role string) []Media {
		copy := append([]Media(nil), items...)
		for index := range copy {
			copy[index].ID = nativeComfyMediaID(copy[index], role, index)
		}
		return copy
	}
	input.ReferenceImages = normalize(input.ReferenceImages, "reference-image")
	input.ReferenceVideos = normalize(input.ReferenceVideos, "reference-video")
	input.ReferenceAudios = normalize(input.ReferenceAudios, "reference-audio")
	if input.Mask != nil {
		copy := *input.Mask
		copy.ID = nativeComfyMediaID(copy, "mask", 0)
		input.Mask = &copy
	}
	return input
}

func (c *Client) pollNativeComfy(ctx context.Context, config Config, input Input, promptID string) (map[string]interface{}, error) {
	if c.Poller == nil {
		return nil, errors.New("ComfyUI 缺少任务轮询端口")
	}
	policy := PollPolicy{
		InitialDelay:          0,
		SkipInitialDelay:      true,
		Interval:              2 * time.Second,
		MaxNotFoundMisses:     3,
		MaxMalformedResponses: 3,
		MaxDownloadTries:      3,
		RetryTransient:        true,
	}
	return c.Poller.Poll(ctx, promptID, policy, func(ctx context.Context) (PollOutcome, error) {
		result, stage, err := c.queryNativeComfy(ctx, config, input, promptID)
		if err == nil && result == nil {
			next := c.Time.Now().Add(policy.Interval)
			if c.Receipt != nil {
				if updateErr := c.Receipt.UpdateStage(ctx, promptID, stage, &next); updateErr != nil {
					return PollOutcome{}, updateErr
				}
			}
		}
		return PollOutcome{Done: result != nil, Result: result}, err
	})
}

func (c *Client) queryNativeComfy(ctx context.Context, config Config, input Input, promptID string) (map[string]interface{}, string, error) {
	body, err := json.Marshal(nil)
	if err != nil {
		return nil, "", err
	}
	history := map[string]any{}
	if err := c.nativeComfyJSONValue(ctx, config, "poll", http.MethodGet, "/history/"+url.PathEscape(promptID), body, "", maxNativeComfyJSONBytes, &history); err != nil {
		return nil, "", err
	}
	entry, ok := history[promptID].(map[string]any)
	if !ok {
		stage, queueErr := c.nativeComfyQueueStage(ctx, config, promptID)
		if queueErr != nil {
			if !errors.Is(queueErr, errNativeComfyNotQueued) {
				return nil, "", queueErr
			}
			return nil, "", fmt.Errorf("ComfyUI 队列与历史中均找不到任务 %s，不会自动重新提交", promptID)
		}
		return nil, stage, nil
	}
	status, _ := entry["status"].(map[string]any)
	statusText := strings.ToLower(strings.TrimSpace(comfyString(status, "status_str")))
	if statusText == "error" {
		return nil, "failed", fmt.Errorf("ComfyUI 工作流执行失败（任务 %s），请在目标服务查看节点错误", promptID)
	}
	completed, _ := status["completed"].(bool)
	if !completed {
		return nil, "正在生成", nil
	}
	outputs, _ := entry["outputs"].(map[string]any)
	outputNode, _ := outputs[config.ComfyUI.OutputNodeID].(map[string]any)
	items, _ := outputNode[config.ComfyUI.OutputField].([]any)
	if len(items) == 0 {
		return nil, "failed", fmt.Errorf("ComfyUI 工作流完成，但输出节点 %s 的 %s 没有文件", config.ComfyUI.OutputNodeID, config.ComfyUI.OutputField)
	}
	images := make([]map[string]interface{}, 0, len(items))
	var video, audio map[string]interface{}
	for index, raw := range items {
		descriptor, _ := raw.(map[string]any)
		filename := strings.TrimSpace(comfyString(descriptor, "filename"))
		subfolder := strings.TrimSpace(comfyString(descriptor, "subfolder"))
		outputType := strings.TrimSpace(comfyString(descriptor, "type"))
		if !safeNativeComfyFile(filename, subfolder) || (outputType != "output" && outputType != "temp") {
			return nil, "failed", errors.New("ComfyUI 输出文件描述无效")
		}
		query := url.Values{"filename": []string{filename}, "subfolder": []string{subfolder}, "type": []string{outputType}}
		data, mimeType, downloadErr := c.nativeComfyRequest(ctx, config, "download", http.MethodGet, "/view?"+query.Encode(), nil, "", maxNativeComfyBodyBytes)
		if downloadErr != nil {
			return nil, "", downloadErr
		}
		if len(data) == 0 {
			return nil, "failed", errors.New("ComfyUI 输出文件为空")
		}
		mimeType = nativeComfyMIME(filename, mimeType, data, nativeComfyAnimated(descriptor, index))
		if !strings.HasPrefix(mimeType, "image/") && !strings.HasPrefix(mimeType, "video/") && !strings.HasPrefix(mimeType, "audio/") {
			return nil, "failed", fmt.Errorf("ComfyUI 输出 %s 的类型 %s 不受支持", filename, mimeType)
		}
		value, _ := workflowOutputValue(mimeType, data).(map[string]interface{})
		if value == nil {
			return nil, "failed", errors.New("ComfyUI 输出内容无效")
		}
		switch {
		case strings.HasPrefix(mimeType, "image/"):
			images = append(images, value)
		case strings.HasPrefix(mimeType, "video/"):
			video = value
		case strings.HasPrefix(mimeType, "audio/"):
			audio = value
		}
	}
	result := map[string]interface{}{"mode": "image"}
	if len(images) > 0 {
		result["images"] = images
	}
	if video != nil {
		result["mode"] = "video"
		result["video"] = video
	}
	if audio != nil {
		result["mode"] = "audio"
		result["audio"] = audio
	}
	if len(images) == 0 && video == nil && audio == nil {
		return nil, "failed", errors.New("ComfyUI 没有返回受支持的媒体输出")
	}
	return result, "succeeded", nil
}

// QueryNativeComfy 只取回已知 prompt 的状态及结果，不上传素材或重新生成。
func (c *Client) QueryNativeComfy(ctx context.Context, input Input, promptID string) (map[string]interface{}, string, error) {
	if err := ValidateNativeComfyConfig(input.Mode, input.Config); err != nil {
		return nil, "", err
	}
	if !input.LocalWorkspace || strings.TrimSpace(promptID) == "" {
		return nil, "", errors.New("取回 ComfyUI 结果需要本地工作区与原 prompt_id")
	}
	return c.prepared().queryNativeComfy(ctx, input.Config, input, promptID)
}

func (c *Client) nativeComfyQueueStage(ctx context.Context, config Config, promptID string) (string, error) {
	queue := map[string]any{}
	if err := c.nativeComfyJSONValue(ctx, config, "poll", http.MethodGet, "/queue", nil, "", maxNativeComfyJSONBytes, &queue); err != nil {
		return "", err
	}
	for _, key := range []string{"queue_running", "queue_pending"} {
		items, _ := queue[key].([]any)
		for _, raw := range items {
			item, _ := raw.([]any)
			if len(item) > 1 && strings.TrimSpace(fmt.Sprint(item[1])) == promptID {
				if key == "queue_running" {
					return "正在生成", nil
				}
				return "排队中", nil
			}
		}
	}
	return "", errNativeComfyNotQueued
}

func (c *Client) uploadNativeComfyFile(ctx context.Context, config Config, media Media, label string) (string, error) {
	if c.Media == nil {
		return "", errors.New("ComfyUI 缺少受保护的素材读取端口")
	}
	data, mimeType, err := c.Media.LocalBytes(media)
	if err != nil {
		return "", fmt.Errorf("读取%s失败：%w", label, err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("%s为空", label)
	}
	if int64(len(data)) > maxNativeComfyUploadBytes {
		return "", fmt.Errorf("%s超过 ComfyUI 上传限制", label)
	}
	mimeType = strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	if label == "参考视频" && !strings.HasPrefix(mimeType, "video/") {
		return "", fmt.Errorf("%s MIME 类型无效：%s", label, mimeType)
	}
	if (label == "参考图片" || label == "蒙版") && !strings.HasPrefix(mimeType, "image/") {
		return "", fmt.Errorf("%s MIME 类型无效：%s", label, mimeType)
	}
	if label == "参考音频" && !strings.HasPrefix(mimeType, "audio/") {
		return "", fmt.Errorf("%s MIME 类型无效：%s", label, mimeType)
	}
	extension := nativeComfyUploadExtension(mimeType)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	filename := "beeftv-" + uuid.NewString() + extension
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "image", "filename": filename}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	_ = writer.WriteField("subfolder", nativeComfyUploadFolder)
	_ = writer.WriteField("type", "input")
	_ = writer.WriteField("overwrite", "false")
	if err = writer.Close(); err != nil {
		return "", err
	}
	response, err := c.nativeComfyJSON(ctx, config, "upload", http.MethodPost, "/upload/image", body.Bytes(), writer.FormDataContentType(), maxNativeComfyJSONBytes)
	if err != nil {
		return "", fmt.Errorf("上传%s到 ComfyUI 失败：%w", label, err)
	}
	name := strings.TrimSpace(comfyString(response, "name"))
	subfolder := strings.TrimSpace(comfyString(response, "subfolder"))
	if name == "" || !safeNativeComfyFile(name, subfolder) {
		return "", errors.New("ComfyUI 未返回安全的上传文件名")
	}
	value := name
	if subfolder != "" {
		value = subfolder + "/" + name
	}
	return value + " [input]", nil
}

// MIME registry ordering varies by OS; native loaders need predictable suffixes.
func nativeComfyUploadExtension(mimeType string) string {
	switch mimeType {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "video/quicktime":
		return ".mov"
	case "audio/wav", "audio/wave", "audio/x-wav":
		return ".wav"
	case "audio/mpeg":
		return ".mp3"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/ogg":
		return ".ogg"
	}
	if extensions, _ := mime.ExtensionsByType(mimeType); len(extensions) > 0 {
		return extensions[0]
	}
	return ".bin"
}

func (c *Client) objectInfo(ctx context.Context, config Config) (map[string]any, error) {
	body, err := json.Marshal(nil)
	if err != nil {
		return nil, err
	}
	nodes := map[string]any{}
	if err := c.nativeComfyJSONValue(ctx, config, "workflow-schema", http.MethodGet, "/object_info", body, "", maxNativeComfyJSONBytes, &nodes); err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return nil, errors.New("ComfyUI 未返回节点清单")
	}
	return nodes, nil
}

// InspectNativeComfy performs read-only discovery against the target service.
// It never installs a node or submits a prompt.
func (c *Client) InspectNativeComfy(ctx context.Context, config Config) (map[string]interface{}, error) {
	exec := c.prepared()
	if _, err := comfyui.ValidateURL(config.BaseURL); err != nil {
		return nil, err
	}
	if exec.Requests == nil {
		return nil, errors.New("ComfyUI 缺少受保护的请求执行端口")
	}
	var stats map[string]interface{}
	if err := exec.nativeComfyJSONValue(ctx, config, "workflow-schema", http.MethodGet, "/system_stats", nil, "", maxNativeComfyJSONBytes, &stats); err != nil {
		return nil, err
	}
	nodes, err := exec.objectInfo(ctx, config)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"stats": stats, "nodes": nodes}, nil
}

// CancelNativeComfy cancels one queued prompt when the target version supports
// precise cancellation. It never calls the shared global interrupt endpoint.
func (c *Client) CancelNativeComfy(ctx context.Context, config Config, promptID string) error {
	if _, err := comfyui.ValidateURL(config.BaseURL); err != nil {
		return err
	}
	if strings.TrimSpace(promptID) == "" {
		return errors.New("缺少 ComfyUI prompt_id")
	}
	body, err := json.Marshal(map[string]any{})
	if err != nil {
		return err
	}
	response, err := c.nativeComfyJSON(ctx, config, "cancel", http.MethodPost, "/api/jobs/"+url.PathEscape(promptID)+"/cancel", body, "application/json", maxNativeComfyJSONBytes)
	if err == nil {
		if cancelled, _ := response["cancelled"].(bool); cancelled {
			return nil
		}
		return errors.New("ComfyUI 未确认取消，任务可能已经结束")
	}
	var status StatusError
	if !errors.As(err, &status) || status.StatusCode != http.StatusNotFound {
		return err
	}
	queue := map[string]any{}
	if err := c.nativeComfyJSONValue(ctx, config, "poll", http.MethodGet, "/queue", nil, "", maxNativeComfyJSONBytes, &queue); err != nil {
		return err
	}
	pending, _ := queue["queue_pending"].([]any)
	queued := false
	for _, raw := range pending {
		item, _ := raw.([]any)
		if len(item) > 1 && strings.TrimSpace(fmt.Sprint(item[1])) == promptID {
			queued = true
			break
		}
	}
	if !queued {
		return errors.New("ComfyUI 任务不在待执行队列中，无法精确取消")
	}
	body, err = json.Marshal(map[string]any{"delete": []string{promptID}})
	if err != nil {
		return err
	}
	if _, _, err := c.nativeComfyRequest(ctx, config, "cancel", http.MethodPost, "/queue", body, "application/json", maxNativeComfyJSONBytes); err != nil {
		return err
	}
	queue = map[string]any{}
	if err := c.nativeComfyJSONValue(ctx, config, "poll", http.MethodGet, "/queue", nil, "", maxNativeComfyJSONBytes, &queue); err != nil {
		return err
	}
	for _, key := range []string{"queue_pending", "queue_running"} {
		items, _ := queue[key].([]any)
		for _, raw := range items {
			item, _ := raw.([]any)
			if len(item) > 1 && strings.TrimSpace(fmt.Sprint(item[1])) == promptID {
				return errors.New("ComfyUI 任务仍在队列中，取消尚未确认")
			}
		}
	}
	state, err := c.NativeComfyCancellationState(ctx, config, promptID)
	if err != nil {
		return err
	}
	if state != "pending" && state != "cancelled" && state != "canceled" {
		return errors.New("ComfyUI 任务在取消确认前已结束，取消尚未确认")
	}
	return nil
}

func (c *Client) NativeComfyCancellationState(ctx context.Context, config Config, promptID string) (string, error) {
	history := map[string]any{}
	if err := c.nativeComfyJSONValue(ctx, config, "cancel-query", http.MethodGet, "/history/"+url.PathEscape(promptID), nil, "", maxNativeComfyJSONBytes, &history); err != nil {
		return "", err
	}
	entry, _ := history[promptID].(map[string]any)
	if entry == nil {
		return "pending", nil
	}
	status, _ := entry["status"].(map[string]any)
	value := strings.ToLower(strings.TrimSpace(comfyString(status, "status_str")))
	switch value {
	case "cancelled", "canceled":
		return "cancelled", nil
	case "error":
		return "failed", nil
	case "success":
		if completed, _ := status["completed"].(bool); completed {
			return "succeeded", nil
		}
		return "running", nil
	default:
		if completed, _ := status["completed"].(bool); completed {
			return "succeeded", nil
		}
		if value == "" {
			value = "running"
		}
		return value, nil
	}
}

func (c *Client) nativeComfyJSON(ctx context.Context, config Config, kind, method, endpoint string, body []byte, contentType string, limit int64) (map[string]any, error) {
	var result map[string]any
	if err := c.nativeComfyJSONValue(ctx, config, kind, method, endpoint, body, contentType, limit, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Client) nativeComfyJSONValue(ctx context.Context, config Config, kind, method, endpoint string, body []byte, contentType string, limit int64, result any) error {
	data, _, err := c.nativeComfyRequest(ctx, config, kind, method, endpoint, body, contentType, limit)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, result); err != nil {
		return fmt.Errorf("ComfyUI 返回了无效 JSON：%w", err)
	}
	return nil
}

func (c *Client) nativeComfyRequest(ctx context.Context, config Config, kind, method, endpoint string, body []byte, contentType string, limit int64) ([]byte, string, error) {
	if c.Requests == nil {
		return nil, "", errors.New("ComfyUI 缺少受保护的请求执行端口")
	}
	base, err := comfyui.ValidateURL(config.BaseURL)
	if err != nil {
		return nil, "", err
	}
	data, responseMIME, err := c.Requests.Execute(ctx, Request{
		Kind: kind, Method: method, URL: base.String() + endpoint,
		Headers: nativeComfyHeaders(config), ContentType: contentType, Body: body,
		NoRedirect: true,
	})
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > limit {
		return nil, "", fmt.Errorf("ComfyUI 响应超过 %d 字节限制", limit)
	}
	return data, responseMIME, nil
}

func nativeComfyHeaders(config Config) []outbound.OutboundHeader {
	headers := make([]outbound.OutboundHeader, len(config.Headers))
	copy(headers, config.Headers)
	switch strings.ToLower(strings.TrimSpace(config.AuthType)) {
	case "bearer":
		headers = append(headers, outbound.OutboundHeader{Name: "Authorization", Value: "Bearer " + strings.TrimSpace(config.APIKey)})
	case "header":
		headers = append(headers, outbound.OutboundHeader{Name: strings.TrimSpace(config.AuthHeader), Value: strings.TrimSpace(config.APIKey)})
	}
	return headers
}

func comfyString(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}

func nativeComfyDefiniteCreateFailure(err error) bool {
	var status StatusError
	if !errors.As(err, &status) {
		return false
	}
	return status.StatusCode == http.StatusBadRequest || status.StatusCode == http.StatusUnauthorized ||
		status.StatusCode == http.StatusForbidden || status.StatusCode == http.StatusUnprocessableEntity
}

func safeNativeComfyFile(name, folder string) bool {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || path.Base(name) != name ||
		strings.ContainsAny(name, "\\/\x00") {
		return false
	}
	folder = strings.TrimSpace(folder)
	if folder == "" {
		return true
	}
	if strings.HasPrefix(folder, "/") || strings.Contains(folder, "\\") || strings.Contains(folder, "\x00") {
		return false
	}
	for _, part := range strings.Split(folder, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func nativeComfyAnimated(descriptor map[string]any, index int) bool {
	switch value := descriptor["animated"].(type) {
	case bool:
		return value
	case []any:
		return index < len(value) && value[index] == true
	default:
		return false
	}
}

func nativeComfyMIME(filename string, declared string, data []byte, animated bool) string {
	detected := strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0])
	extension := strings.ToLower(path.Ext(filename))
	if detected == "application/ogg" && (extension == ".ogg" || extension == ".opus") {
		return "audio/ogg"
	}
	if detected != "" && detected != "application/octet-stream" {
		if animated && extension == ".gif" {
			return "image/gif"
		}
		return detected
	}
	switch extension {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".wav":
		return "audio/wav"
	case ".mp3":
		return "audio/mpeg"
	case ".flac":
		return "audio/flac"
	case ".ogg", ".opus":
		return "audio/ogg"
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	}
	return strings.TrimSpace(strings.Split(declared, ";")[0])
}

func validateNativeComfyTarget(graph map[string]any, fields []Field, nodes map[string]any) error {
	mediaFields := map[string]bool{}
	for _, field := range fields {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		if isWorkflowMediaSource(normalizeWorkflowFieldSource(field)) {
			mediaFields[field.NodeID+"."+field.FieldName] = true
		}
	}
	for nodeID, raw := range graph {
		node, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("ComfyUI 节点 %s 不是 API 格式对象", nodeID)
		}
		classType, _ := node["class_type"].(string)
		rawTarget, exists := nodes[strings.TrimSpace(classType)]
		if !exists {
			return fmt.Errorf("目标 ComfyUI 缺少节点 %s（%s），请选择兼容的工作流或服务", nodeID, classType)
		}
		target, ok := rawTarget.(map[string]any)
		if !ok {
			return fmt.Errorf("目标 ComfyUI 节点 %s 的 schema 无效", classType)
		}
		inputs, _ := node["inputs"].(map[string]any)
		inputContainer, _ := target["input"].(map[string]any)
		for fieldName, rawValue := range inputs {
			if isWorkflowLinkValue(rawValue) {
				continue
			}
			spec, specOK := nativeComfyTargetInputSpec(inputContainer, inputs, fieldName, "")
			if !specOK {
				return fmt.Errorf("目标 ComfyUI 节点 %s 不支持输入 %s", classType, fieldName)
			}
			if mediaFields[nodeID+"."+fieldName] {
				continue
			}
			if options, hasOptions := nativeComfyOptions(spec); hasOptions && !nativeComfyOptionAllows(options, fmt.Sprint(rawValue), spec) {
				return fmt.Errorf("目标 ComfyUI 节点 %s 的 %s 不支持值 %v", classType, fieldName, rawValue)
			}
		}
	}
	return nil
}

func nativeComfyInputSpec(container map[string]any, fieldName string) ([]any, bool) {
	for _, group := range []string{"required", "optional"} {
		values, _ := container[group].(map[string]any)
		raw, ok := values[fieldName].([]any)
		if ok {
			return raw, true
		}
	}
	return nil, false
}

// V3 dynamic widgets flatten selected child inputs (e.g. format.codec).
// Resolve children against the selected option on this target's schema.
func nativeComfyTargetInputSpec(container, values map[string]any, fieldName, prefix string) ([]any, bool) {
	if spec, ok := nativeComfyInputSpec(container, fieldName); ok {
		return spec, true
	}
	root, child, nested := strings.Cut(fieldName, ".")
	if !nested {
		return nil, false
	}
	spec, ok := nativeComfyInputSpec(container, root)
	if !ok || len(spec) < 2 || spec[0] != "COMFY_DYNAMICCOMBO_V3" {
		return nil, false
	}
	metadata, _ := spec[1].(map[string]any)
	options, _ := metadata["options"].([]any)
	selected := fmt.Sprint(values[prefix+root])
	for _, raw := range options {
		option, _ := raw.(map[string]any)
		if fmt.Sprint(option["key"]) == selected {
			children, _ := option["inputs"].(map[string]any)
			return nativeComfyTargetInputSpec(children, values, child, prefix+root+".")
		}
	}
	return nil, false
}

func nativeComfyOptions(spec []any) ([]any, bool) {
	if len(spec) == 0 {
		return nil, false
	}
	switch options := spec[0].(type) {
	case []any:
		return options, true
	default:
		if len(spec) < 2 {
			return nil, false
		}
		metadata, _ := spec[1].(map[string]any)
		choices, ok := metadata["options"].([]any)
		if !ok {
			return nil, false
		}
		if spec[0] == "COMFY_DYNAMICCOMBO_V3" {
			keys := make([]any, 0, len(choices))
			for _, raw := range choices {
				option, _ := raw.(map[string]any)
				if key, exists := option["key"]; exists {
					keys = append(keys, key)
				}
			}
			return keys, true
		}
		return choices, true
	}
}

func nativeComfyOptionAllows(options []any, value string, spec []any) bool {
	for _, item := range options {
		if strings.TrimSpace(fmt.Sprint(item)) == strings.TrimSpace(value) {
			return true
		}
	}
	return nativeComfyUploadSpec(spec)
}

func nativeComfyUploadSpec(spec []any) bool {
	if len(spec) < 2 {
		return false
	}
	metadata, ok := spec[1].(map[string]any)
	if !ok {
		return false
	}
	for _, key := range []string{"image_upload", "video_upload", "audio_upload"} {
		if value, ok := metadata[key].(bool); ok && value {
			return true
		}
	}
	return false
}
