package handler

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

var (
	customGeminiRelayPath      = regexp.MustCompile(`(?:^|/)models/[^/:]+:(generateContent|streamGenerateContent|predictLongRunning)$`)
	customVideoTaskPath        = regexp.MustCompile(`(?:^|/)video/generations/[^/]+$`)
	customXAIVideoTaskPath     = regexp.MustCompile(`(?:^|/)videos/[^/]+$`)
	customVideoContentPath     = regexp.MustCompile(`(?:^|/)videos/[^/]+/content$`)
	customArkVideoTaskPath     = regexp.MustCompile(`(?:^|/)contents/generations/tasks/[^/]+$`)
	customGeminiOperationPath  = regexp.MustCompile(`(?:^|/)(?:models/[^/]+/)?operations/[^/]+$`)
	customNovitaTaskResultPath = regexp.MustCompile(`(?:^|/)async/task-result$`)
	customMiniMaxTaskPath      = regexp.MustCompile(`(?:^|/)v2/query/video_generation/[^/]+$`)
)

func authorizeCustomRelay(method string, target *url.URL, apiFormat string, contentType string) error {
	requestPath, err := normalizedCustomRelayPath(target.EscapedPath())
	if err != nil {
		return err
	}
	query, err := url.ParseQuery(target.RawQuery)
	if err != nil {
		return errors.New("自定义渠道查询参数无效")
	}
	for key := range query {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "key", "api_key", "access_token", "token":
			return errors.New("自定义渠道地址不允许在查询参数中携带密钥")
		}
	}

	apiFormat = strings.ToLower(strings.TrimSpace(apiFormat))
	if apiFormat != "openai" && apiFormat != "gemini" && apiFormat != "claude" {
		return errors.New("自定义渠道调用格式无效")
	}
	if method == http.MethodGet {
		if apiFormat == "openai" && requestPath == "/agnesapi" {
			if len(query) == 2 && len(query["video_id"]) == 1 && len(query["model_name"]) == 1 && strings.TrimSpace(query.Get("video_id")) != "" && strings.TrimSpace(query.Get("model_name")) != "" {
				return nil
			}
			return errors.New("Agnes 视频查询必须提供 video_id 和 model_name")
		}
		if customNovitaTaskResultPath.MatchString(requestPath) {
			if len(query) == 1 && len(query["task_id"]) == 1 && strings.TrimSpace(query.Get("task_id")) != "" {
				return nil
			}
			return errors.New("自定义渠道不允许访问该上游接口")
		}
		allowed := requestPath == "/models" || strings.HasSuffix(requestPath, "/models")
		if apiFormat == "openai" {
			allowed = allowed || customVideoTaskPath.MatchString(requestPath) || customXAIVideoTaskPath.MatchString(requestPath) || customVideoContentPath.MatchString(requestPath) || customArkVideoTaskPath.MatchString(requestPath) || customMiniMaxTaskPath.MatchString(requestPath)
		} else if apiFormat == "gemini" {
			allowed = allowed || customGeminiOperationPath.MatchString(requestPath)
		}
		if len(query) != 0 || !allowed {
			return errors.New("自定义渠道不允许访问该上游接口")
		}
		return nil
	}
	if method != http.MethodPost {
		return errors.New("自定义渠道不允许使用该请求方法")
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return errors.New("自定义渠道生成请求类型无效")
	}
	if apiFormat == "openai" {
		multipartAllowed := mediaType == "multipart/form-data" && (strings.HasSuffix(requestPath, "/images/edits") || strings.HasSuffix(requestPath, "/videos"))
		jsonAllowed := mediaType == "application/json" && (strings.HasSuffix(requestPath, "/responses") || strings.HasSuffix(requestPath, "/chat/completions") || strings.HasSuffix(requestPath, "/images/generations") || strings.HasSuffix(requestPath, "/images/edits") || strings.HasSuffix(requestPath, "/audio/speech") || strings.HasSuffix(requestPath, "/video/generations") || strings.HasSuffix(requestPath, "/videos/generations") || strings.HasSuffix(requestPath, "/videos") || strings.HasSuffix(requestPath, "/contents/generations/tasks") || strings.HasSuffix(requestPath, "/video/create") || strings.HasSuffix(requestPath, "/v2/video_generation"))
		if len(query) != 0 || (!multipartAllowed && !jsonAllowed) {
			return errors.New("自定义渠道不允许访问该上游接口")
		}
		return nil
	}
	if apiFormat == "claude" {
		if mediaType != "application/json" || !strings.HasSuffix(requestPath, "/messages") {
			return errors.New("Claude 自定义渠道只允许 application/json 的 /messages 请求")
		}
		return nil
	}
	if mediaType != "application/json" {
		return errors.New("Gemini 自定义渠道生成请求必须使用 application/json")
	}
	if !customGeminiRelayPath.MatchString(requestPath) {
		return errors.New("自定义渠道不允许访问该上游接口")
	}
	if len(query) == 0 {
		return nil
	}
	if len(query) == 1 && len(query["alt"]) == 1 && query.Get("alt") == "sse" && strings.HasSuffix(requestPath, ":streamGenerateContent") {
		return nil
	}
	return errors.New("自定义渠道不允许使用该查询参数")
}

func normalizedCustomRelayPath(value string) (string, error) {
	if len(value) > 2048 {
		return "", errors.New("自定义渠道请求路径过长")
	}
	decoded, err := url.PathUnescape(value)
	if err != nil || strings.Contains(decoded, "\\") || strings.Contains(decoded, "\x00") {
		return "", errors.New("自定义渠道请求路径无效")
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(decoded, "/"))
	if cleaned != decoded && cleaned != "/"+strings.TrimPrefix(decoded, "/") {
		return "", errors.New("自定义渠道请求路径无效")
	}
	return cleaned, nil
}

func enforcePolicyRateLimit(c *gin.Context, policy app.RuntimePolicySetting, key string, limit int, window time.Duration) bool {
	if policy.Request.Unlimited {
		return true
	}
	return enforceRateLimit(c, key, limit, window)
}

func enforceRateLimit(c *gin.Context, key string, limit int, window time.Duration) bool {
	dependencies, ok := runtimeDependencies(c)
	if !ok || dependencies.RequestCoordinator == nil {
		fail(c, http.StatusServiceUnavailable, errors.New("请求协调器尚未初始化"))
		return false
	}
	allowed, err := dependencies.RequestCoordinator.AllowRequest(c.Request.Context(), key, limit, window)
	if err != nil {
		fail(c, http.StatusServiceUnavailable, errors.New("请求协调服务暂时不可用"))
		return false
	}
	if allowed {
		return true
	}
	wait := dependencies.RequestCoordinator.RequestRetryAfter(c.Request.Context(), key, window)
	seconds := max(1, int((wait+time.Second-1)/time.Second))
	c.Header("Retry-After", strconv.Itoa(seconds))
	failService(c, app.RateLimited(fmt.Sprintf("请求次数已达上限，请在 %d 秒后重试", seconds)))
	return false
}

// runtimePolicies is the only platform read shared by request throttling.
type runtimePolicies interface {
	RuntimePolicy() (app.RuntimePolicySetting, error)
}

func loadRuntimePolicy(c *gin.Context, policies runtimePolicies) (app.RuntimePolicySetting, bool) {
	policy, err := policies.RuntimePolicy()
	if err != nil {
		failInternal(c, http.StatusServiceUnavailable, err)
		return app.RuntimePolicySetting{}, false
	}
	return policy, true
}
