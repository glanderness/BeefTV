package operations

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/kernel"
)

func decodeParams(params json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) {
			return InvalidArg("invalid_params", "参数类型不正确: 字段 "+typeErr.Field)
		}
		if field, ok := unknownField(err); ok {
			return newError(CodeInvalidArgument, "unknown_field", "参数包含未知字段: "+field,
				map[string]any{"field": field})
		}
		return InvalidArg("invalid_params", err.Error())
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return InvalidArg("invalid_params", "参数包含多余内容")
	}
	return nil
}

func unknownField(err error) (string, bool) {
	const prefix = `json: unknown field `
	message := err.Error()
	if !strings.HasPrefix(message, prefix) {
		return "", false
	}
	name := strings.Trim(strings.TrimPrefix(message, prefix), `"`)
	if name == "" {
		return "", false
	}
	return name, true
}

var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|authorization|password|credential|private[_-]?key)`)

func sanitizeForClient(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if secretKeyPattern.MatchString(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = sanitizeForClient(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, sanitizeForClient(item))
		}
		return out
	case string:
		if strings.Contains(typed, "?") && secretKeyPattern.MatchString(typed) {
			if idx := strings.Index(typed, "?"); idx > 0 {
				return typed[:idx]
			}
		}
		return typed
	default:
		return value
	}
}

func mapDomainError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return NotFound("not_found", "资源不存在")
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) {
		switch appErr.Status {
		case http.StatusNotFound:
			return NotFound("not_found", appErr.Message)
		case http.StatusConflict:
			return Conflict("stale_revision", appErr.Message, nil)
		case http.StatusPreconditionFailed:
			return PreconditionFailed("precondition_failed", appErr.Message, nil)
		case http.StatusBadRequest:
			if appErr.Reason == kernel.ReasonUnsupportedField {
				return InvalidArg(string(kernel.ReasonUnsupportedField), appErr.Message)
			}
			return InvalidArg("invalid_request", appErr.Message)
		}
	}
	var conflicter interface{ IsConflict() bool }
	if errors.As(err, &conflicter) && conflicter.IsConflict() {
		return Conflict("stale_write", "写入冲突，已停止覆盖", nil)
	}
	return AsError(err)
}
