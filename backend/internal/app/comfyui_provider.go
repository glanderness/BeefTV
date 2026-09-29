package app

// 原生 ComfyUI 的本地工作流协议适配集中在这里。
//
// 与 RunningHub 的关键差异：ComfyUI 是自托管服务，提交与结果走 /prompt、
// /history/{prompt_id}、/view 三个原生端点，没有鉴权，也不需要把参考素材
// 上传到云端。协议形状决定了它无法用声明式 manifest 表达：/history 以
// prompt_id 作为动态顶层 key，产物是 filename/subfolder 而不是 URL，
// 需要再拼 /view 查询参数。

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

const defaultComfyUIRootURL = "http://127.0.0.1:8188"

// comfyUISeedRandomMax 是 2^53-1（JavaScript 安全整数上限）。ComfyUI 的 seed
// 声明上限是 uint64 最大值，抽随机值时必须收敛到该上限。
const comfyUISeedRandomMax int64 = 9007199254740991

// isComfyUIInterface 判断渠道接口是否属于原生 ComfyUI 工作流。
func isComfyUIInterface(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(model.ChannelInterfaceComfyUIImage), string(model.ChannelInterfaceComfyUIVideo):
		return true
	default:
		return false
	}
}

// comfyUIRootURL 归一化用户保存的 ComfyUI 地址。
//
// 不能复用 apiURL：渠道通用拼接会强插 /v1 前缀，而 ComfyUI 的 /prompt、
// /history、/view、/object_info 全部位于根路径下。
func comfyUIRootURL(value string) string {
	base := strings.TrimRight(strings.TrimSpace(value), "/")
	if base == "" {
		return defaultComfyUIRootURL
	}
	return base
}

func (s *Service) runComfyUIWorkflow(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	// 视频与音频参考需要 ComfyUI 侧对应的加载节点，本阶段只处理图片参考。
	// 蒙版走 /upload/mask 与 inpaint 节点，同样留待后续。
	if len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 || input.Mask != nil {
		return nil, errors.New("ComfyUI 暂不支持视频、音频参考素材与蒙版")
	}
	root := comfyUIRootURL(input.Config.BaseURL)
	if resumed := resumedProviderRequestID(ctx); resumed != "" {
		return s.pollComfyUIWorkflow(ctx, root, resumed, input.Mode)
	}
	workflowFields := workflowFieldsForMode(input.Config.WorkflowFields, input.Mode)
	if err := validateWorkflowMediaInputs(workflowFields, input); err != nil {
		return nil, err
	}
	// 参考图必须先落到 ComfyUI 的 input 目录，工作流里引用的是上传返回的文件名。
	files := make(map[string]string, len(input.ReferenceImages))
	for _, media := range input.ReferenceImages {
		name, err := s.uploadComfyUIMedia(ctx, root, media)
		if err != nil {
			return nil, err
		}
		files[media.ID] = name
	}
	prompt, err := buildComfyUIPromptBody(input.Config, input, files)
	if err != nil {
		return nil, err
	}
	var submitted map[string]any
	if err := comfyUIPostJSON(ctx, root+"/prompt", map[string]interface{}{
		"prompt":    prompt,
		"client_id": comfyUIClientID(),
	}, &submitted); err != nil {
		return nil, fmt.Errorf("ComfyUI 工作流提交失败：%w", err)
	}
	if message := comfyUITaskError(submitted); message != "" {
		return nil, fmt.Errorf("ComfyUI 工作流提交失败：%s", message)
	}
	taskID := strings.TrimSpace(stringValue(submitted["prompt_id"]))
	if taskID == "" {
		return nil, errors.New("ComfyUI 未返回 prompt_id")
	}
	if err := s.recordWorkflowProviderRequest(ctx, taskID, "submitted", nil); err != nil {
		// 上游已经接受请求；继续轮询可以在状态写入恢复后保住结果和 prompt_id。
		metadata, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
		_ = s.log(metadata.UserID, metadata.TaskID, "error", "ComfyUI 请求状态保存失败", taskID+"："+err.Error())
	}
	return s.pollComfyUIWorkflow(ctx, root, taskID, input.Mode)
}

// uploadComfyUIMedia 把参考素材上传到 ComfyUI 的 input 目录，返回工作流里引用的文件名。
//
// 上游响应是 {name, subfolder, type}；subfolder 非空时工作流里必须写成
// "subfolder/name"，否则 LoadImage 找不到文件。
func (s *Service) uploadComfyUIMedia(ctx context.Context, root string, media providerMedia) (string, error) {
	raw, mimeType, err := mediaBytes(media)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", errors.New("ComfyUI 参考素材为空")
	}
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{
		"name":     "image",
		"filename": providerMediaFilename(media, mimeType),
	}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(raw); err != nil {
		return "", err
	}
	// 同名素材重复上传时直接覆盖，避免上游 input 目录累积文件。
	_ = writer.WriteField("type", "input")
	_ = writer.WriteField("overwrite", "true")
	if err := writer.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(withProviderRequestKind(ctx, "upload"), http.MethodPost, root+"/upload/image", body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	var uploaded map[string]any
	if err := comfyUIDoJSON(req, &uploaded); err != nil {
		return "", fmt.Errorf("ComfyUI 参考素材上传失败：%w", err)
	}
	name := strings.TrimSpace(stringValue(uploaded["name"]))
	if name == "" {
		return "", errors.New("ComfyUI 上传响应缺少文件名")
	}
	if subfolder := strings.TrimSpace(stringValue(uploaded["subfolder"])); subfolder != "" {
		return subfolder + "/" + name, nil
	}
	return name, nil
}

// buildComfyUIPromptBody 把字段映射写回工作流副本，得到 /prompt 需要的对象。
//
// 必须深拷贝：任务失败重试会复用同一份 Config，原地修改会让上一次的字段值
// 累积到下一次提交。
func buildComfyUIPromptBody(config providerConfig, input canvasGenerationInput, files map[string]string) (map[string]interface{}, error) {
	if len(config.WorkflowJSON) == 0 {
		return nil, errors.New("ComfyUI 缺少工作流 JSON，请在设置页粘贴 API 格式工作流")
	}
	workflow, err := deepCopyJSONMap(config.WorkflowJSON)
	if err != nil {
		return nil, err
	}
	// files 是已上传参考素材的节点文件名映射；没有参考图时为空。
	if files == nil {
		files = map[string]string{}
	}
	for _, field := range workflowFieldsForMode(config.WorkflowFields, input.Mode) {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		nodeID := strings.TrimSpace(field.NodeID)
		fieldName := strings.TrimSpace(field.FieldName)
		if nodeID == "" || fieldName == "" {
			continue
		}
		node, ok := workflow[nodeID].(map[string]interface{})
		if !ok {
			continue
		}
		inputs, ok := node["inputs"].(map[string]interface{})
		if !ok {
			continue
		}
		original, exists := inputs[fieldName]
		if exists && isWorkflowLinkValue(original) {
			// 已连接的输入属于工作流拓扑，字段映射不能把它拆成字面量覆盖，
			// 否则会断开上游节点并让 /prompt 校验失败。
			continue
		}
		value, present, err := resolveWorkflowFieldValue(field, files, input)
		if err != nil {
			return nil, err
		}
		if !present {
			if field.Required && !exists {
				return nil, fmt.Errorf("工作流字段 %s 缺少值", comfyUIFieldLabel(field))
			}
			continue
		}
		if err := validateRunningHubWorkflowFieldValue(field, value); err != nil {
			return nil, err
		}
		coerced, err := coerceComfyUIInputValue(field, original, value)
		if err != nil {
			return nil, err
		}
		inputs[fieldName] = coerced
	}
	return workflow, nil
}

// coerceComfyUIInputValue 把统一字段值还原成 ComfyUI 声明的输入类型。
//
// 这是与 RunningHub 最大的差异：RunningHub 的 nodeInfoList 只接受字符串，
// 而 ComfyUI 的 /prompt 会按 object_info 校验类型，INT/BOOLEAN 收到字符串会
// 直接以 400 拒绝整份工作流。
func coerceComfyUIInputValue(field WorkflowField, original interface{}, value interface{}) (interface{}, error) {
	switch strings.ToUpper(strings.TrimSpace(field.FieldType)) {
	case "INT", "INTEGER":
		return comfyUIIntegerValue(field, value)
	case "FLOAT", "NUMBER", "SLIDER":
		return comfyUIFloatValue(field, value)
	case "BOOLEAN":
		return comfyUIBooleanValue(field, value)
	case "STRING", "COMBO":
		return comfyUIOriginalTypedValue(original, value), nil
	}
	// object_info 不可用时，以工作流里的原始值类型作为类型真相。
	switch original.(type) {
	case bool:
		return comfyUIBooleanValue(field, value)
	case float64:
		return comfyUIFloatValue(field, value)
	case string:
		return workflowScalarString(value), nil
	}
	return value, nil
}

func comfyUIIntegerValue(field WorkflowField, value interface{}) (interface{}, error) {
	numeric, ok := workflowNumericBound(value)
	if !ok {
		return nil, fmt.Errorf("ComfyUI 字段 %s 需要整数，收到 %v", comfyUIFieldLabel(field), value)
	}
	rounded := math.Round(numeric)
	if rounded < math.MinInt64 || rounded > math.MaxInt64 {
		return nil, fmt.Errorf("ComfyUI 字段 %s 超出整数范围", comfyUIFieldLabel(field))
	}
	return int64(rounded), nil
}

func comfyUIFloatValue(field WorkflowField, value interface{}) (interface{}, error) {
	numeric, ok := workflowNumericBound(value)
	if !ok {
		return nil, fmt.Errorf("ComfyUI 字段 %s 需要数字，收到 %v", comfyUIFieldLabel(field), value)
	}
	return numeric, nil
}

func comfyUIBooleanValue(field WorkflowField, value interface{}) (interface{}, error) {
	if parsed, ok := value.(bool); ok {
		return parsed, nil
	}
	switch strings.ToLower(strings.TrimSpace(workflowScalarString(value))) {
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off", "":
		return false, nil
	}
	return nil, fmt.Errorf("ComfyUI 字段 %s 需要布尔值，收到 %v", comfyUIFieldLabel(field), value)
}

// comfyUIOriginalTypedValue 保持工作流原始值的类型。部分 COMBO 输入用数字
// 枚举，统一转字符串会让 /prompt 校验失败。
func comfyUIOriginalTypedValue(original interface{}, value interface{}) interface{} {
	switch original.(type) {
	case string:
		return workflowScalarString(value)
	case float64:
		if numeric, ok := workflowNumericBound(value); ok {
			return numeric
		}
	}
	return value
}

func comfyUIFieldLabel(field WorkflowField) string {
	return firstNonEmptyString(
		strings.TrimSpace(field.ID),
		strings.TrimSpace(field.NodeID)+"."+strings.TrimSpace(field.FieldName),
	)
}

func (s *Service) pollComfyUIWorkflow(ctx context.Context, root string, taskID string, mode string) (map[string]interface{}, error) {
	return s.pollComfyUIWorkflowWithPolicy(ctx, root, taskID, comfyUIPollPolicy(mode))
}

// pollComfyUIWorkflowWithPolicy 把轮询策略显式传入，便于测试用毫秒级间隔覆盖
// 完整的提交到落盘链路。
func (s *Service) pollComfyUIWorkflowWithPolicy(ctx context.Context, root string, taskID string, policy videoPollPolicy) (map[string]interface{}, error) {
	return runVideoPollLoop(ctx, taskID, policy, func(ctx context.Context) (videoPollOutcome, error) {
		var payload map[string]any
		if err := comfyUIGetJSON(withProviderRequestKind(ctx, "poll"), root+"/history/"+url.PathEscape(taskID), &payload); err != nil {
			return videoPollOutcome{}, fmt.Errorf("ComfyUI 查询任务失败：%w", err)
		}
		entry, found, err := comfyUIHistoryEntry(taskID, payload)
		if err != nil {
			return videoPollOutcome{}, err
		}
		if !found {
			// ComfyUI 在任务完成前不会写入 /history，空对象是正常等待而不是失败，
			// 因此这里返回 nil error 让轮询继续，而不是计入 not-found 次数。
			_ = s.updateWorkflowProviderState(ctx, taskID, "running", ptr(time.Now().Add(policy.Interval)))
			return videoPollOutcome{}, nil
		}
		if message := comfyUIHistoryFailure(entry); message != "" {
			return videoPollOutcome{}, fmt.Errorf("ComfyUI 任务失败：%s", message)
		}
		urls := comfyUIOutputURLs(root, entry["outputs"])
		if len(urls) == 0 {
			if !comfyUIHistoryCompleted(entry) {
				// 条目已出现但还没执行完，继续等待。
				_ = s.updateWorkflowProviderState(ctx, taskID, "running", ptr(time.Now().Add(policy.Interval)))
				return videoPollOutcome{}, nil
			}
			return videoPollOutcome{}, errors.New("ComfyUI 任务完成但没有返回产物")
		}
		result, err := s.downloadComfyUIOutputs(ctx, urls, taskID, policy)
		if err != nil {
			return videoPollOutcome{}, err
		}
		_ = s.updateWorkflowProviderState(ctx, taskID, "succeeded", nil)
		return videoPollOutcome{Done: true, Result: result}, nil
	})
}

// comfyUIPollPolicy 使用比云端视频渠道更短的间隔：ComfyUI 是本地或可信网络
// 内的服务，默认 30s 的轮询会让图片任务体感明显变慢。
func comfyUIPollPolicy(mode string) videoPollPolicy {
	policy := defaultVideoPollPolicy()
	if strings.EqualFold(strings.TrimSpace(mode), "video") {
		policy.InitialDelay = 2 * time.Second
		policy.Interval = 5 * time.Second
		return policy
	}
	policy.InitialDelay = time.Second
	policy.Interval = 2 * time.Second
	return policy
}

// comfyUIHistoryEntry 取出当前任务在 /history 响应里的条目。
//
// 响应以 prompt_id 作为顶层 key；任务完成前返回空对象，此时 found 为 false。
func comfyUIHistoryEntry(promptID string, payload map[string]any) (map[string]interface{}, bool, error) {
	if len(payload) == 0 {
		return nil, false, nil
	}
	if entry, ok := payload[promptID].(map[string]interface{}); ok {
		return entry, true, nil
	}
	// 少数反向代理会改写 key；只有一个条目时按唯一 key 兜底，
	// 多于一个时无法判断归属，宁可继续等待也不能取错结果。
	if len(payload) == 1 {
		for _, raw := range payload {
			if entry, ok := raw.(map[string]interface{}); ok {
				return entry, true, nil
			}
		}
	}
	return nil, false, nil
}

func comfyUIHistoryCompleted(entry map[string]interface{}) bool {
	status, ok := entry["status"].(map[string]interface{})
	if !ok {
		return false
	}
	completed, ok := status["completed"].(bool)
	return ok && completed
}

// comfyUIHistoryFailure 只在 status_str 明确为 error 时返回失败消息，
// 避免把执行中的中间状态当成终态。
func comfyUIHistoryFailure(entry map[string]interface{}) string {
	status, ok := entry["status"].(map[string]interface{})
	if !ok {
		return ""
	}
	if !strings.EqualFold(strings.TrimSpace(stringValue(status["status_str"])), "error") {
		return ""
	}
	return comfyUIStatusMessages(status)
}

// comfyUIStatusMessages 解析 status.messages。ComfyUI 的条目形状为
// [["execution_error", {"node_id": "6", "exception_message": "..."}], ...]。
func comfyUIStatusMessages(status map[string]interface{}) string {
	raw, ok := status["messages"].([]interface{})
	if !ok {
		return "ComfyUI 执行失败"
	}
	parts := make([]string, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.([]interface{})
		if !ok || len(entry) < 2 {
			continue
		}
		detail, ok := entry[1].(map[string]interface{})
		if !ok {
			continue
		}
		message := firstNonEmptyString(
			strings.TrimSpace(stringValue(detail["exception_message"])),
			strings.TrimSpace(stringValue(detail["message"])),
		)
		if message == "" {
			continue
		}
		if nodeID := strings.TrimSpace(stringValue(detail["node_id"])); nodeID != "" {
			message = "节点 " + nodeID + "：" + message
		}
		parts = append(parts, message)
	}
	if len(parts) == 0 {
		return "ComfyUI 执行失败"
	}
	return strings.Join(parts, "；")
}

// sortComfyUINodeIDs 让数字型节点 ID 按数值排序，避免纯字符串比较把 "12"
// 排在 "9" 前面，让产物与错误信息的顺序符合工作流里的节点编号。
func sortComfyUINodeIDs(ids []string) {
	sort.Slice(ids, func(i, j int) bool {
		left, leftErr := strconv.Atoi(ids[i])
		right, rightErr := strconv.Atoi(ids[j])
		if leftErr == nil && rightErr == nil {
			return left < right
		}
		return ids[i] < ids[j]
	})
}

// comfyUIOutputURLs 遍历 outputs[nodeId] 的产物数组，拼成 /view 下载地址。
func comfyUIOutputURLs(root string, raw interface{}) []string {
	outputs, ok := raw.(map[string]interface{})
	if !ok || len(outputs) == 0 {
		return nil
	}
	nodeIDs := make([]string, 0, len(outputs))
	for nodeID := range outputs {
		nodeIDs = append(nodeIDs, nodeID)
	}
	sortComfyUINodeIDs(nodeIDs)
	urls := make([]string, 0, len(nodeIDs))
	for _, nodeID := range nodeIDs {
		node, ok := outputs[nodeID].(map[string]interface{})
		if !ok {
			continue
		}
		// 不同 ComfyUI 版本把视频产物放在 gifs 或 videos 下，两者都要处理。
		for _, key := range []string{"images", "gifs", "videos", "audio"} {
			items, ok := node[key].([]interface{})
			if !ok {
				continue
			}
			for _, item := range items {
				file, ok := item.(map[string]interface{})
				if !ok {
					continue
				}
				if value := comfyUIViewURL(root, file); value != "" {
					urls = append(urls, value)
				}
			}
		}
	}
	return urls
}

func comfyUIViewURL(root string, file map[string]interface{}) string {
	filename := strings.TrimSpace(stringValue(file["filename"]))
	if filename == "" {
		return ""
	}
	query := url.Values{}
	query.Set("filename", filename)
	// subfolder 可能含 `/` 与空格，必须整体作为查询参数值编码，
	// 不能当作路径分段处理。
	query.Set("subfolder", strings.TrimSpace(stringValue(file["subfolder"])))
	outputType := strings.TrimSpace(stringValue(file["type"]))
	if outputType == "" {
		outputType = "output"
	}
	query.Set("type", outputType)
	return root + "/view?" + query.Encode()
}

// comfyUITaskError 提取 ComfyUI 的错误描述。节点级校验错误比顶层 error 更能
// 指出是哪一步配置有问题，因此优先展示。
func comfyUITaskError(payload map[string]any) string {
	if len(payload) == 0 {
		return ""
	}
	parts := make([]string, 0, 2)
	if message := comfyUINodeErrors(payload["node_errors"]); message != "" {
		parts = append(parts, message)
	}
	if raw, ok := payload["error"].(map[string]interface{}); ok {
		message := strings.TrimSpace(stringValue(raw["message"]))
		details := strings.TrimSpace(stringValue(raw["details"]))
		if message != "" {
			if details != "" && details != message {
				message += "（" + details + "）"
			}
			parts = append(parts, message)
		}
	}
	return strings.Join(parts, "；")
}

func comfyUINodeErrors(raw interface{}) string {
	nodes, ok := raw.(map[string]interface{})
	if !ok || len(nodes) == 0 {
		return ""
	}
	nodeIDs := make([]string, 0, len(nodes))
	for nodeID, item := range nodes {
		if entry, ok := item.(map[string]interface{}); ok && len(entry) > 0 {
			nodeIDs = append(nodeIDs, nodeID)
		}
	}
	sortComfyUINodeIDs(nodeIDs)
	parts := make([]string, 0, len(nodeIDs))
	for _, nodeID := range nodeIDs {
		entry, ok := nodes[nodeID].(map[string]interface{})
		if !ok {
			continue
		}
		errorsList, ok := entry["errors"].([]interface{})
		if !ok {
			continue
		}
		for _, item := range errorsList {
			detail, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			message := firstNonEmptyString(
				strings.TrimSpace(stringValue(detail["message"])),
				strings.TrimSpace(stringValue(detail["details"])),
			)
			if message == "" {
				continue
			}
			label := nodeID
			if classType := strings.TrimSpace(stringValue(entry["class_type"])); classType != "" {
				label = nodeID + "（" + classType + "）"
			}
			parts = append(parts, fmt.Sprintf("节点 %s：%s", label, message))
		}
	}
	return strings.Join(parts, "；")
}

func comfyUIPostJSON(ctx context.Context, endpoint string, body interface{}, target *map[string]any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return comfyUIDoJSON(req, target)
}

func comfyUIGetJSON(ctx context.Context, endpoint string, target *map[string]any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	return comfyUIDoJSON(req, target)
}

// comfyUIDoJSON 走通用出站通道（含 SSRF 校验与大小上限）。ComfyUI 没有鉴权，
// 这里不注入任何 Authorization 头。target 为 nil 时只校验请求成功，忽略响应体
// （/queue 与 /interrupt 成功时返回空 body）。
func comfyUIDoJSON(req *http.Request, target *map[string]any) error {
	data, _, err := doBinary(req)
	if err != nil {
		if message := comfyUIHTTPFailureMessage(err); message != "" {
			return errors.New(message)
		}
		return err
	}
	if target == nil {
		return nil
	}
	if len(bytes.TrimSpace(data)) == 0 {
		*target = map[string]any{}
		return nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return providerResponseDecodeError{Err: err}
	}
	return nil
}

// comfyUIDeleteQueuedPrompt 从 ComfyUI 的待执行队列里移除指定任务。
//
// ComfyUI 的 {"delete": [...]} 只作用于 pending 队列，对正在执行的任务无效，
// 因此这一步是精确且无副作用的：任务已开始时也只是删不掉而已。
func comfyUIDeleteQueuedPrompt(ctx context.Context, root string, promptID string) error {
	return comfyUIPostJSON(ctx, root+"/queue", map[string]interface{}{"delete": []string{promptID}}, nil)
}

// comfyUIInterruptPrompt 中断指定任务。
//
// 必须显式带 prompt_id：不带该字段时 ComfyUI 会**全局中断**，在共享实例上会
// 误伤他人的任务。ComfyUI 只在节点边界检查中断标志，单个长节点执行期间可能
// 来不及生效。
func comfyUIInterruptPrompt(ctx context.Context, root string, promptID string) error {
	return comfyUIPostJSON(ctx, root+"/interrupt", map[string]interface{}{"prompt_id": promptID}, nil)
}

// comfyUIQueuedPromptIDs 从 /queue 响应里取出正在执行与排队中的 prompt_id。
// 队列条目形状为 [序号, prompt_id, workflow, extra]。
func comfyUIQueuedPromptIDs(queue map[string]any) (running []string, pending []string) {
	collect := func(key string) []string {
		items, _ := queue[key].([]interface{})
		ids := make([]string, 0, len(items))
		for _, item := range items {
			entry, ok := item.([]interface{})
			if !ok || len(entry) < 2 {
				continue
			}
			if id := strings.TrimSpace(stringValue(entry[1])); id != "" {
				ids = append(ids, id)
			}
		}
		return ids
	}
	return collect("queue_running"), collect("queue_pending")
}

// comfyUIInterrupted 判断 history 条目是否因中断而结束。被 /interrupt 结束的
// 任务 status_str 同样是 error，只能靠 execution_interrupted 消息区分。
func comfyUIInterrupted(entry map[string]interface{}) bool {
	status, ok := entry["status"].(map[string]interface{})
	if !ok {
		return false
	}
	messages, ok := status["messages"].([]interface{})
	if !ok {
		return false
	}
	for _, item := range messages {
		message, ok := item.([]interface{})
		if !ok || len(message) == 0 {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(stringValue(message[0])), "execution_interrupted") {
			return true
		}
	}
	return false
}

// cancelComfyUITask 取消 ComfyUI 任务。两步都只影响目标任务，可以无条件都发：
//   - {"delete": [prompt_id]} 移除仍排队中的任务，精确且立即生效；
//   - /interrupt 带 prompt_id 中断正在执行的任务。
//
// 任务若已结束，两者都不会生效，因此不需要先查询状态。
func cancelComfyUITask(ctx context.Context, config providerConfig, promptID string) error {
	root := comfyUIRootURL(config.BaseURL)
	if err := comfyUIDeleteQueuedPrompt(ctx, root, promptID); err != nil {
		return err
	}
	return comfyUIInterruptPrompt(ctx, root, promptID)
}

// queryComfyUICancellation 查询 ComfyUI 任务的取消结果。
//
// 关键依据：被从队列删除的任务**不会写入 /history**，因此「既不在队列、也不在
// history」即表示取消成功。被 /interrupt 结束的任务会以 error 写入 history，
// 只能靠 execution_interrupted 消息与真正的执行失败区分。
func queryComfyUICancellation(ctx context.Context, config providerConfig, promptID string) (providerCancellationOutcome, string, error) {
	root := comfyUIRootURL(config.BaseURL)
	var queue map[string]any
	if err := comfyUIGetJSON(ctx, root+"/queue", &queue); err != nil {
		return "", "", err
	}
	running, pending := comfyUIQueuedPromptIDs(queue)
	for _, id := range running {
		if id == promptID {
			// 中断只在节点边界被检查，长节点执行期间仍会显示 here。
			return providerCancellationPending, "running", nil
		}
	}
	for _, id := range pending {
		if id == promptID {
			return providerCancellationPending, "queued", nil
		}
	}
	var history map[string]any
	if err := comfyUIGetJSON(ctx, root+"/history/"+url.PathEscape(promptID), &history); err != nil {
		return "", "", err
	}
	entry, found, err := comfyUIHistoryEntry(promptID, history)
	if err != nil {
		return "", "", err
	}
	if !found {
		return providerCancellationConfirmed, "removed", nil
	}
	// 被 /interrupt 中断的任务是 status_str=error 且 completed=false，必须先按
	// execution_interrupted 判定；否则会被误认为仍在执行而永远停在待确认。
	if comfyUIInterrupted(entry) {
		return providerCancellationConfirmed, "interrupted", nil
	}
	if !comfyUIHistoryCompleted(entry) {
		return providerCancellationPending, "executing", nil
	}
	if message := comfyUIHistoryFailure(entry); message != "" {
		return providerCancellationFailed, "error", nil
	}
	return providerCancellationSucceeded, "success", nil
}

// comfyUIHTTPFailureMessage 解析 /prompt 的校验失败响应：ComfyUI 用 HTTP 400
// 加 error/node_errors 说明哪个节点的哪个输入不合法。
func comfyUIHTTPFailureMessage(err error) string {
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return ""
	}
	body := strings.TrimSpace(httpErr.Body)
	if body == "" {
		return ""
	}
	var payload map[string]any
	if json.Unmarshal([]byte(body), &payload) != nil {
		return ""
	}
	return comfyUITaskError(payload)
}

// comfyUIClientID 生成 client_id。宿主不使用 WebSocket 进度，但带上它能让
// ComfyUI 的队列和日志更好地归属到本次提交。
func comfyUIClientID() string {
	buffer := make([]byte, 16)
	if _, err := cryptorand.Read(buffer); err != nil {
		return "beeftv"
	}
	return hex.EncodeToString(buffer)
}

// deepCopyJSONMap 通过 JSON 往返做深拷贝，避免就地修改任务携带的工作流。
func deepCopyJSONMap(source map[string]interface{}) (map[string]interface{}, error) {
	encoded, err := json.Marshal(source)
	if err != nil {
		return nil, fmt.Errorf("ComfyUI 工作流 JSON 编码失败：%w", err)
	}
	var copied map[string]interface{}
	if err := json.Unmarshal(encoded, &copied); err != nil {
		return nil, fmt.Errorf("ComfyUI 工作流 JSON 解析失败：%w", err)
	}
	return copied, nil
}
