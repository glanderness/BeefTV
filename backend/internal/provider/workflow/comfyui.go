package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/outbound"
)

func IsComfyUIInterface(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "comfyui-image", "comfyui-video", "comfyui-audio":
		return true
	}
	return false
}

// Native ComfyUI uses the same outbound network policy as custom channels.
func ComfyUIRootURL(value string) (string, error) {
	u, err := outbound.ValidateCustomRelayURL(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("ComfyUI 地址不能包含查询参数或片段")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func ValidateComfyUIWorkflow(prompt map[string]any) error {
	if len(prompt) == 0 || len(prompt) > 4096 {
		return errors.New("请导入 ComfyUI 的 API 格式工作流 JSON（1 至 4096 个节点）")
	}
	for id, raw := range prompt {
		node, ok := raw.(map[string]any)
		classType, validClass := node["class_type"].(string)
		if !ok || strings.TrimSpace(id) == "" || !validClass || strings.TrimSpace(classType) == "" {
			return errors.New("工作流必须是 ComfyUI API JSON，不能使用包含 nodes/links 的界面格式")
		}
		inputs, ok := node["inputs"].(map[string]any)
		if !ok {
			return fmt.Errorf("ComfyUI 节点 %s 缺少 inputs", id)
		}
		for _, value := range inputs {
			if isWorkflowLinkValue(value) {
				link := value.([]any)
				nodeID, validID := link[0].(string)
				index, indexErr := strconv.Atoi(fmt.Sprint(link[1]))
				if _, exists := prompt[nodeID]; !exists || !validID || indexErr != nil || index < 0 {
					return fmt.Errorf("ComfyUI 节点 %s 引用了不存在的节点", id)
				}
			}
		}
	}
	return nil
}

// InspectComfyUI validates installed node classes and exposes their real enums
// (including checkpoints) without executing a workflow.
func (c *Client) InspectComfyUI(ctx context.Context, config Config, mode string) (map[string]any, error) {
	c = c.prepared()
	if mode != "image" && mode != "video" && mode != "audio" {
		return nil, kernel.NewAppError(http.StatusBadRequest, "ComfyUI 工作流用途必须是图片、视频或音频")
	}
	if err := ValidateComfyUIWorkflow(config.WorkflowJSON); err != nil {
		return nil, kernel.NewAppError(http.StatusBadRequest, err.Error())
	}
	info, err := c.comfyUIJSON(ctx, config, http.MethodGet, "/object_info", "workflow-schema", nil)
	if err != nil {
		return nil, fmt.Errorf("无法读取 ComfyUI 节点与模型目录：%w", err)
	}
	fields := CollectFields(config.WorkflowJSON, mode)
	for id, raw := range config.WorkflowJSON {
		node := raw.(map[string]any)
		classType := stringValue(node["class_type"])
		if _, ok := info[classType].(map[string]any); !ok {
			return nil, kernel.NewAppError(http.StatusBadRequest, fmt.Sprintf("ComfyUI 未安装节点 %s（%s）", classType, id))
		}
	}
	// CollectFields returns the same JSON contract as the shared graph editor.
	for _, field := range fields {
		classInfo, _ := info[stringValue(field["classType"])].(map[string]any)
		inputInfo, _ := classInfo["input"].(map[string]any)
		for _, group := range []string{"required", "optional"} {
			definitions, _ := inputInfo[group].(map[string]any)
			definition, _ := definitions[stringValue(field["fieldName"])].([]any)
			if len(definition) == 0 {
				continue
			}
			if options, ok := definition[0].([]any); ok {
				field["options"], field["optionsSource"] = options, "workflow"
				switch stringValue(field["fieldName"]) {
				case "ckpt_name", "lora_name", "vae_name", "unet_name", "clip_name", "model_name", "control_net_name":
					field["enabled"], field["role"] = true, "business"
				}
			} else if fieldType, ok := definition[0].(string); ok {
				field["fieldType"] = fieldType
			}
			if len(definition) > 1 {
				if limits, ok := definition[1].(map[string]any); ok {
					for _, key := range []string{"min", "max", "step"} {
						if value, exists := limits[key]; exists {
							field[key] = value
						}
					}
				}
			}
		}
		if isManagementSeedField(stringValue(field["fieldName"])) {
			if max, ok := workflowNumericBound(field["max"]); ok && max > 9007199254740991 {
				field["max"] = int64(9007199254740991)
			}
		}
	}
	return map[string]any{"workflowJson": config.WorkflowJSON, "fields": fields}, nil
}

func (c *Client) comfyUIJSON(ctx context.Context, config Config, method, endpoint, kind string, payload any) (map[string]any, error) {
	root, err := ComfyUIRootURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	var body []byte
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	data, _, err := c.execute(ctx, Request{Kind: kind, Method: method, URL: root + endpoint, Headers: comfyUIHeaders(config), ContentType: "application/json", Body: body, CustomRelay: true})
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil || result == nil {
		return nil, errors.New("ComfyUI 返回了无效的 JSON")
	}
	return result, nil
}

func comfyUIHeaders(config Config) []outbound.OutboundHeader {
	headers := append([]outbound.OutboundHeader(nil), config.Headers...)
	for _, header := range headers {
		if strings.EqualFold(header.Name, "Authorization") {
			return headers
		}
	}
	if key := strings.TrimSpace(config.APIKey); key != "" {
		headers = append(headers, outbound.OutboundHeader{Name: "Authorization", Value: "Bearer " + key})
	}
	return headers
}

func (c *Client) runComfyUI(ctx context.Context, input Input) (map[string]any, error) {
	if err := ValidateConfig(input.Mode, input.Config); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.ResumedRequestID) == "" {
		if err := c.requirePaidCreate(ctx); err != nil {
			return nil, err
		}
		fields := input.Config.WorkflowFields
		if len(fields) == 0 {
			var err error
			fields, err = FieldsFromManagement(input.Config.WorkflowJSON, input.Mode)
			if err != nil {
				return nil, err
			}
		}
		fields = FieldsForMode(fields, input.Mode)
		if err := validateWorkflowMediaInputs(fields, input); err != nil {
			return nil, err
		}
		files := map[string]string{}
		media := append(append(append([]Media{}, input.ReferenceImages...), input.ReferenceVideos...), input.ReferenceAudios...)
		if input.Mask != nil {
			media = append(media, *input.Mask)
		}
		identities := map[string]Media{}
		for _, item := range media {
			if strings.TrimSpace(item.ID) == "" {
				return nil, errors.New("ComfyUI 参考素材缺少 ID")
			}
			if previous, exists := identities[item.ID]; exists && previous != item {
				return nil, errors.New("ComfyUI 参考素材 ID 冲突")
			}
			identities[item.ID] = item
		}
		for _, item := range media {
			if _, uploaded := files[item.ID]; uploaded {
				continue
			}
			name, err := c.uploadComfyUIMedia(ctx, input.Config, item)
			if err != nil {
				return nil, err
			}
			files[item.ID] = name
		}
		prompt, err := buildComfyUIPrompt(input, fields, files)
		if err != nil {
			return nil, err
		}
		submitted, err := c.comfyUIJSON(ctx, input.Config, http.MethodPost, "/prompt", "create", map[string]any{"prompt": prompt})
		if err != nil {
			var status StatusError
			if errors.As(err, &status) && status.StatusCode >= 400 && status.StatusCode < 500 && status.StatusCode != http.StatusRequestTimeout {
				return nil, fmt.Errorf("ComfyUI 拒绝工作流（HTTP %d），请检查鉴权、节点参数与模型文件", status.StatusCode)
			}
			return nil, CreateUncertain{Err: err}
		}
		if submitted["error"] != nil {
			return nil, errors.New("ComfyUI 拒绝工作流，请检查节点参数与模型文件")
		}
		id := stringValue(submitted["prompt_id"])
		if id == "" {
			return nil, CreateUncertain{Err: errors.New("ComfyUI 未返回 prompt_id")}
		}
		if err := c.Receipt.RecordAccepted(ctx, id, "submitted", nil); err != nil {
			return nil, AcceptedNotRecorded{RequestID: id, Stage: "submitted", Err: err}
		}
		input.ResumedRequestID = id
	}
	for deadline := c.Time.PollDeadline(ctx); c.Time.Now().Before(deadline); {
		result, stage, err := c.queryComfyUI(ctx, input.Config, input.ResumedRequestID, input.Mode)
		if err != nil {
			return nil, err
		}
		if result != nil {
			if c.Receipt != nil {
				if err := c.Receipt.UpdateStage(ctx, input.ResumedRequestID, "succeeded", nil); err != nil {
					return nil, err
				}
			}
			return result, nil
		}
		interval := c.Time.LegacyPollInterval()
		next := c.Time.Now().Add(interval)
		if c.Receipt != nil {
			if err := c.Receipt.UpdateStage(ctx, input.ResumedRequestID, stage, &next); err != nil {
				return nil, err
			}
		}
		if err := c.Time.Sleep(ctx, interval); err != nil {
			return nil, err
		}
	}
	return nil, errors.New("ComfyUI 任务等待超时，可继续查询原任务")
}

func buildComfyUIPrompt(input Input, fields []Field, files map[string]string) (map[string]any, error) {
	encoded, err := json.Marshal(input.Config.WorkflowJSON)
	if err != nil {
		return nil, err
	}
	var prompt map[string]any
	if err := json.Unmarshal(encoded, &prompt); err != nil {
		return nil, err
	}
	for _, field := range fields {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		node, ok := prompt[field.NodeID].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("工作流映射节点 %s 不存在", field.NodeID)
		}
		inputs := node["inputs"].(map[string]any)
		original, exists := inputs[field.FieldName]
		if !exists || isWorkflowLinkValue(original) {
			return nil, fmt.Errorf("不能覆盖工作流拓扑输入 %s.%s", field.NodeID, field.FieldName)
		}
		if field.RandomEnabled {
			// The editor stores JSON numbers. Keep seeds exactly representable in
			// JavaScript and normalize decoded float bounds before randomization.
			for _, bound := range []*any{&field.Min, &field.Max} {
				if *bound == nil {
					continue
				}
				number, ok := workflowNumericBound(*bound)
				if !ok || math.Trunc(number) != number || number < -9007199254740991 {
					return nil, errors.New("ComfyUI 随机值范围必须是有效整数")
				}
				if number > 9007199254740991 {
					if bound == &field.Min {
						return nil, errors.New("ComfyUI 随机值下限超过可精确表示的整数范围")
					}
					number = 9007199254740991
				}
				*bound = int64(number)
			}
		}
		value, present, err := resolveWorkflowFieldValue(field, files, input)
		if normalizeWorkflowFieldSource(field) == "" && !field.RandomEnabled {
			value = firstNonNilWorkflowValue(field.FieldValue, field.Value)
			present = value != nil
			err = nil
		}
		if err != nil {
			return nil, err
		}
		if !present {
			if field.Required {
				return nil, fmt.Errorf("工作流字段 %s.%s 缺少值", field.NodeID, field.FieldName)
			}
			continue
		}
		// Dynamic sources use UI strings; ComfyUI needs JSON numbers/booleans.
		if text, ok := value.(string); ok {
			fieldType := strings.ToUpper(strings.TrimSpace(field.FieldType))
			if _, numeric := original.(float64); numeric && fieldType != "INT" && fieldType != "FLOAT" {
				fieldType = "NUMBER"
			}
			if _, boolean := original.(bool); boolean {
				fieldType = "BOOLEAN"
			}
			switch fieldType {
			case "INT":
				parsed, parseErr := strconv.ParseInt(text, 10, 64)
				if parseErr != nil {
					return nil, fmt.Errorf("%s 必须是整数", field.FieldName)
				}
				value = parsed
			case "FLOAT", "NUMBER":
				parsed, parseErr := strconv.ParseFloat(text, 64)
				if parseErr != nil {
					return nil, fmt.Errorf("%s 必须是数值", field.FieldName)
				}
				value = parsed
			case "BOOLEAN", "BOOL":
				parsed, parseErr := strconv.ParseBool(text)
				if parseErr != nil {
					return nil, fmt.Errorf("%s 必须是布尔值", field.FieldName)
				}
				value = parsed
			}
		}
		if err := validateRunningHubWorkflowFieldValue(field, value); err != nil {
			return nil, err
		}
		inputs[field.FieldName] = value
	}
	return prompt, nil
}

func (c *Client) uploadComfyUIMedia(ctx context.Context, config Config, media Media) (string, error) {
	if c.Media == nil {
		return "", errors.New("ComfyUI 缺少素材读取端口")
	}
	raw, mimeType, err := c.Media.LocalBytes(media)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", errors.New("ComfyUI 参考素材为空")
	}
	root, err := ComfyUIRootURL(config.BaseURL)
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", mediaFilename(media, mimeType))
	if err != nil {
		return "", err
	}
	if _, err = part.Write(raw); err != nil {
		return "", err
	}
	if err = writer.WriteField("subfolder", "beeftv"); err != nil {
		return "", err
	}
	if err = writer.WriteField("type", "input"); err != nil {
		return "", err
	}
	if err = writer.Close(); err != nil {
		return "", err
	}
	data, _, err := c.execute(ctx, Request{Kind: "upload", Method: http.MethodPost, URL: root + "/upload/image", Headers: comfyUIHeaders(config), ContentType: writer.FormDataContentType(), Body: body.Bytes(), CustomRelay: true})
	if err != nil {
		return "", err
	}
	var result struct {
		Name      string `json:"name"`
		Subfolder string `json:"subfolder"`
	}
	if err := json.Unmarshal(data, &result); err != nil || result.Name == "" {
		return "", errors.New("ComfyUI 上传未返回文件名")
	}
	return comfyUIFilePath(result.Name, result.Subfolder)
}

func comfyUIFilePath(filename, subfolder string) (string, error) {
	if filename == "" || filename == "." || filename == ".." || path.Base(filename) != filename || strings.ContainsAny(filename+subfolder, "\\\x00") || strings.HasPrefix(subfolder, "/") {
		return "", errors.New("ComfyUI 返回了无效的媒体路径")
	}
	for _, segment := range strings.Split(subfolder, "/") {
		if segment == ".." {
			return "", errors.New("ComfyUI 返回了无效的媒体路径")
		}
	}
	return path.Join(subfolder, filename), nil
}

func (c *Client) queryComfyUI(ctx context.Context, config Config, taskID, mode string) (map[string]any, string, error) {
	history, err := c.comfyUIJSON(ctx, config, http.MethodGet, "/history/"+url.PathEscape(taskID), "poll", nil)
	if err != nil {
		return nil, "", err
	}
	entry, ok := history[taskID].(map[string]any)
	if !ok {
		return nil, "pending", nil
	}
	status, _ := entry["status"].(map[string]any)
	if stringValue(status["status_str"]) == "error" {
		return nil, "failed", errors.New("ComfyUI 执行失败，请检查 ComfyUI 节点错误日志")
	}
	outputs, _ := entry["outputs"].(map[string]any)
	completed, _ := status["completed"].(bool)
	if !completed {
		return nil, "running", nil
	}
	root, err := ComfyUIRootURL(config.BaseURL)
	if err != nil {
		return nil, "", err
	}
	result := map[string]any{"mode": mode}
	keys := make([]string, 0, len(outputs))
	for key := range outputs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	seen := map[string]bool{}
	for _, key := range keys {
		output, _ := outputs[key].(map[string]any)
		for _, group := range []string{"images", "gifs", "videos", "audio", "audios"} {
			items, _ := output[group].([]any)
			for _, raw := range items {
				item, _ := raw.(map[string]any)
				filename := stringValue(item["filename"])
				if filename == "" {
					continue
				}
				if _, err := comfyUIFilePath(filename, stringValue(item["subfolder"])); err != nil {
					return nil, "", err
				}
				extensionMIME := runningHubOutputMimeType(filename, "")
				if extensionMIME == "" {
					extensionMIME = strings.Split(mime.TypeByExtension(strings.ToLower(path.Ext(filename))), ";")[0]
				}
				knownMedia := strings.HasPrefix(extensionMIME, "image/") || strings.HasPrefix(extensionMIME, "video/") || strings.HasPrefix(extensionMIME, "audio/")
				if knownMedia && !strings.HasPrefix(extensionMIME, mode+"/") {
					continue
				}
				values := url.Values{"filename": {filename}, "subfolder": {stringValue(item["subfolder"])}, "type": {firstNonEmpty(stringValue(item["type"]), "output")}}
				endpoint := root + "/view?" + values.Encode()
				if seen[endpoint] {
					continue
				}
				seen[endpoint] = true
				data, mimeType, err := c.execute(ctx, Request{Kind: "download", Method: http.MethodGet, URL: endpoint, Headers: comfyUIHeaders(config), CustomRelay: true})
				if err != nil {
					return nil, "", err
				}
				if len(data) == 0 {
					return nil, "", errors.New("ComfyUI 返回了空媒体文件")
				}
				mimeType = strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
				if !strings.HasPrefix(mimeType, "image/") && !strings.HasPrefix(mimeType, "video/") && !strings.HasPrefix(mimeType, "audio/") {
					if mimeType != "" && mimeType != "application/octet-stream" && mimeType != "binary/octet-stream" && mimeType != "application/ogg" {
						return nil, "", errors.New("ComfyUI 返回了非媒体内容，请检查输出文件与反向代理鉴权")
					}
					mimeType = extensionMIME
				}
				value := workflowOutputValue(mimeType, data)
				if value == nil {
					continue
				}
				switch {
				case mode == "image" && strings.HasPrefix(mimeType, "image/"):
					images, _ := result["images"].([]any)
					result["images"] = append(images, value)
				case mode == "video" && strings.HasPrefix(mimeType, "video/"):
					result["video"] = value
					return result, "succeeded", nil
				case mode == "audio" && strings.HasPrefix(mimeType, "audio/"):
					result["audio"] = value
					return result, "succeeded", nil
				}
			}
		}
	}
	if len(result) == 1 {
		return nil, "failed", errors.New("ComfyUI 已完成，但没有返回与工作流用途匹配的媒体；请添加保存输出节点")
	}
	return result, "succeeded", nil
}
