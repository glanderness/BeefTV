package workflow

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func runningHubWorkflowFailureMessage(response map[string]any) string {
	message := runningHubFailureMessage(response)
	normalized := strings.ToLower(message)
	if strings.Contains(message, "企业版余额不足") || (strings.Contains(normalized, "enterprise") && strings.Contains(normalized, "balance")) {
		return message + "；工作流提交固定使用积分 API Key，请确认提交 Key 不是企业级素材上传 Key"
	}
	return message
}
func runningHubUploadAuthFailure(err error) string {
	var httpErr StatusError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusUnauthorized {
		return ""
	}
	if !strings.Contains(strings.ToLower(httpErr.Body), "apikey verification failed") {
		return ""
	}
	return "RunningHub 参考素材上传接口认证失败（HTTP 401）：ApiKey verification failed。请确认“素材上传 API Key（企业级）”有效，并且它与 Base URL 属于同一个 RunningHub 站点"
}

// RunningHub 工作流的管理、提交和轮询固定使用积分 API Key；企业级 Key 仅由上传接口单独读取。
func runningHubAPIKey(config Config) string {
	return strings.TrimSpace(config.APIKey)
}
func runningHubOutputMimeType(rawURL string, declared string) string {
	declared = strings.TrimSpace(strings.Split(declared, ";")[0])
	if declared != "" && declared != "application/octet-stream" {
		return declared
	}
	pathValue := rawURL
	if parsed, err := url.Parse(rawURL); err == nil && parsed.Path != "" {
		pathValue = parsed.Path
	}
	pathValue = strings.ToLower(strings.Split(pathValue, "?")[0])
	for suffix, mimeType := range map[string]string{
		".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
		".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
		".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
	} {
		if strings.HasSuffix(pathValue, suffix) {
			return mimeType
		}
	}
	return declared
}

func workflowOutputValue(mimeType string, data []byte) interface{} {
	mimeType = strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	if len(data) == 0 {
		return nil
	}
	return map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType, "bytes": len(data)}
}

func runningHubRootURL(value string) string {
	base := strings.TrimRight(strings.TrimSpace(value), "/")
	if base == "" {
		base = "https://www.runninghub.cn"
	}
	// 设置页可能保存根地址、/openapi/v2 或带尾部斜杠的任一形式；任务
	// OpenAPI 使用根地址下的 /task/openapi/*，统一剥掉 API 前缀。
	lower := strings.ToLower(base)
	for _, suffix := range []string{"/openapi/v2", "/openapi"} {
		if strings.HasSuffix(lower, suffix) {
			base = base[:len(base)-len(suffix)]
			break
		}
	}
	return strings.TrimRight(base, "/")
}

func resolveRunningHubOutputURL(root string, rawURL string) string {
	rawURL = rewriteRunningHubOutputHost(strings.TrimSpace(rawURL))
	if rawURL == "" || strings.HasPrefix(rawURL, "data:") || isPublicMediaURL(rawURL) {
		return rawURL
	}
	if strings.HasPrefix(rawURL, "//") {
		return "https:" + rawURL
	}
	if strings.HasPrefix(rawURL, "/") {
		return strings.TrimRight(root, "/") + rawURL
	}
	// API 可能返回 output/foo、assets/foo 这类无前导斜杠的相对路径。
	for _, prefix := range []string{"output/", "assets/", "input/"} {
		if strings.HasPrefix(strings.ToLower(rawURL), prefix) {
			return strings.TrimRight(root, "/") + "/" + rawURL
		}
	}
	if runningHubRelativeOutputPath(rawURL) {
		return strings.TrimRight(root, "/") + "/" + strings.TrimLeft(rawURL, "/")
	}
	return rawURL
}

// RunningHub 某些区域会返回旧 COS 域名，参考项目已将其迁移到可访问域名；
// 这里只做固定 host 映射，不接受响应内容提供任意代理目标。
func rewriteRunningHubOutputHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return rawURL
	}
	if strings.EqualFold(parsed.Host, "rh-images-1252422369.cos.ap-beijing.myqcloud.com") {
		parsed.Host = "rh-images.xiaoyaoyou.com"
		return parsed.String()
	}
	return rawURL
}

func runningHubTaskID(payload map[string]any) string {
	for _, keys := range [][]string{{"data", "taskId"}, {"data", "task_id"}, {"data", "taskID"}, {"data", "id"}, {"taskId"}, {"task_id"}, {"taskID"}, {"id"}} {
		if len(keys) == 2 {
			if value := nestedString(payload, keys[0], keys[1]); value != "" {
				return value
			}
		} else if value := stringValue(payload[keys[0]]); value != "" {
			return value
		}
	}
	return ""
}

func runningHubOutputURLs(value interface{}) []string {
	result := make([]string, 0)
	var visit func(interface{})
	visit = func(current interface{}) {
		switch item := current.(type) {
		case string:
			if strings.HasPrefix(item, "http://") || strings.HasPrefix(item, "https://") || strings.HasPrefix(item, "data:") || (strings.HasPrefix(item, "/") && !strings.HasPrefix(item, "//")) || runningHubRelativeOutputPath(item) {
				result = append(result, item)
			}
		case []interface{}:
			for _, child := range item {
				visit(child)
			}
		case map[string]interface{}:
			for key, child := range item {
				lowerKey := strings.ToLower(strings.TrimSpace(key))
				if lowerKey == "fileurl" || lowerKey == "file_url" || lowerKey == "url" || lowerKey == "downloadurl" || lowerKey == "download_url" || lowerKey == "src" || lowerKey == "output" || lowerKey == "outputs" || lowerKey == "results" || lowerKey == "files" || lowerKey == "data" || lowerKey == "images" || lowerKey == "videos" || lowerKey == "audio" || lowerKey == "audios" || lowerKey == "result" {
					visit(child)
				}
			}
		}
	}
	visit(value)
	seen := map[string]bool{}
	deduped := make([]string, 0, len(result))
	for _, item := range result {
		if !seen[item] {
			seen[item] = true
			deduped = append(deduped, item)
		}
	}
	return deduped
}

func runningHubRelativeOutputPath(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || strings.Contains(value, "://") || strings.HasPrefix(value, "//") {
		return false
	}
	for _, segment := range strings.Split(strings.Split(value, "?")[0], "/") {
		if segment == ".." {
			return false
		}
	}
	for _, prefix := range []string{"output/", "assets/", "input/"} {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	for _, suffix := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".m4a", ".flac"} {
		if strings.HasSuffix(strings.Split(value, "?")[0], suffix) {
			return true
		}
	}
	return false
}

func runningHubFailureMessage(payload map[string]any) string {
	for _, key := range []string{"msg", "message", "error", "failReason", "failedReason", "errorMessage"} {
		if value := stringValue(payload[key]); value != "" {
			return runningHubActionableFailureMessage(value)
		}
	}
	if nested, ok := payload["data"].(map[string]interface{}); ok {
		return runningHubFailureMessage(nested)
	}
	return "上游未提供失败原因"
}

func isWorkflowSeedField(value string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.TrimSpace(value)))
	return normalized == "seed" || strings.HasSuffix(normalized, "seed") || strings.Contains(normalized, "noiseseed")
}

func runningHubActionableFailureMessage(message string) string {
	normalized := strings.ToLower(message)
	if strings.Contains(normalized, "node_info_mismatch") || strings.Contains(normalized, "node_not_found_in_workflow") {
		return "RunningHub AI 应用的公开参数已变化，请到“设置 → RunningHub 工作流”重新选择该 App 并点击“拉取参数”后再试（上游详情：" + message + "）"
	}
	return message
}

// runningHubPayloadCode 兼容 code/statusCode 以及部分网关返回的字符串状态。
// 统一映射到 RunningHub 公开状态码：0 成功、804 运行中、813 排队中、805/806 失败。
func runningHubPayloadCode(payload map[string]any) (int, bool) {
	if payload == nil {
		return 0, false
	}
	topCode, topValid := runningHubDirectCode(payload)
	if nested, ok := payload["data"].(map[string]interface{}); ok {
		if nestedCode, nestedValid := runningHubPayloadCode(nested); nestedValid {
			// 有些网关把 HTTP 成功包装成顶层 code=0，同时把真实任务状态放在
			// data.code/status；真实任务状态优先，避免把排队任务误判成完成。
			if !topValid || topCode == 0 || nestedCode != 0 {
				return nestedCode, true
			}
		}
	}
	return topCode, topValid
}

func runningHubDirectCode(payload map[string]any) (int, bool) {
	primaryCode := 0
	primaryValid := false
	for _, key := range []string{"code", "statusCode", "status_code"} {
		if value, ok := payload[key]; ok {
			if code, valid := runningHubCode(value); valid {
				if (key == "statusCode" || key == "status_code") && code >= 200 && code < 300 {
					code = 0
				}
				primaryCode, primaryValid = code, true
				break
			}
		}
	}
	for _, key := range []string{"status", "state", "taskStatus", "task_status"} {
		if code, valid := runningHubStatusCode(payload[key]); valid {
			if !primaryValid || primaryCode == 0 || code != 0 {
				return code, true
			}
			break
		}
	}
	if primaryValid {
		return primaryCode, true
	}
	// errorCode=0 通常只是“无错误”标记，不能覆盖 data.status=running。
	for _, key := range []string{"errorCode", "error_code"} {
		if value, ok := payload[key]; ok {
			if code, valid := runningHubCode(value); valid && code != 0 {
				return code, true
			}
		}
	}
	return 0, false
}

func runningHubStatusCode(value interface{}) (int, bool) {
	text := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	if text == "" || text == "<nil>" {
		return 0, false
	}
	if numeric, ok := runningHubCode(text); ok {
		switch numeric {
		case 0, 804, 813, 805, 806:
			return numeric, true
		}
	}
	text = strings.NewReplacer("_", "", "-", "", " ", "").Replace(text)
	switch text {
	case "success", "succeeded", "complete", "completed", "done", "finished", "finish", "3":
		return 0, true
	case "queued", "queue", "pending", "waiting", "created", "submitted":
		return 813, true
	case "running", "processing", "executing", "inprogress", "started", "working", "1", "2":
		return 804, true
	case "failed", "failure", "error", "rejected", "cancelled", "canceled", "expired", "aborted", "4", "5":
		return 805, true
	default:
		return 0, false
	}
}

func nestedString(payload map[string]any, first string, second string) string {
	nested, _ := payload[first].(map[string]interface{})
	return stringValue(nested[second])
}

func runningHubFileName(payload map[string]any) string {
	for _, key := range []string{"fileName", "file_name", "filename", "name"} {
		if value := stringValue(payload[key]); value != "" {
			return value
		}
	}
	for _, container := range []string{"data", "result", "file", "files"} {
		if nested, ok := payload[container].(map[string]interface{}); ok {
			for _, key := range []string{"fileName", "file_name", "filename", "name"} {
				if value := stringValue(nested[key]); value != "" {
					return value
				}
			}
		}
	}
	return ""
}

func runningHubCode(value interface{}) (int, bool) {
	switch item := value.(type) {
	case int:
		if item < 0 {
			return 0, false
		}
		return item, true
	case int64:
		if item < 0 {
			return 0, false
		}
		return int(item), true
	case float64:
		code := int(item)
		if item < 0 || float64(code) != item {
			return 0, false
		}
		return code, true
	case json.Number, string:
		code := mapNumber(item)
		return code, code >= 0
	default:
		return 0, false
	}
}

func mapNumber(value interface{}) int {
	switch item := value.(type) {
	case int:
		return item
	case int64:
		return int(item)
	case float64:
		return int(item)
	case json.Number:
		parsed, _ := strconv.Atoi(string(item))
		return parsed
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(item))
		return parsed
	default:
		return -1
	}
}
