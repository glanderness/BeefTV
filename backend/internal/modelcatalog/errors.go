package modelcatalog

import "infinite-canvas/backend/internal/kernel"

// ModelErrorCode 是模型选择/路由/供应商失败的稳定机器可读码。
type ModelErrorCode string

const (
	ErrCodeModelCapabilityNotSupported ModelErrorCode = "model_capability_not_supported"
	ErrCodeModelRouteUnavailable       ModelErrorCode = "model_route_unavailable"
	ErrCodeProviderRequestFailed       ModelErrorCode = "provider_request_failed"
	ErrCodeModelCatalogMismatch        ModelErrorCode = "model_catalog_mismatch"
	ErrCodeInvalidModelSelection       ModelErrorCode = "invalid_model_selection"
)

// ModelError 嵌入 AppError，HTTP 投影通过 errors.As 读取 status/reason/文案。
type ModelError struct {
	*kernel.AppError
	ErrorCode ModelErrorCode
	Details   map[string]any
}

func (e *ModelError) Error() string {
	if e == nil {
		return ""
	}
	if e.AppError != nil {
		return e.AppError.Error()
	}
	return string(e.ErrorCode)
}

func NewModelError(code ModelErrorCode, message string) *ModelError {
	err := kernel.NewAppError(400, message)
	err.Reason = kernel.ErrorReason(code)
	return &ModelError{AppError: err, ErrorCode: code, Details: map[string]any{}}
}

func (e *ModelError) WithDetails(details map[string]any) *ModelError {
	if e == nil {
		return e
	}
	e.Details = details
	return e
}

func ModelCapabilityNotSupported(message string) error {
	if message == "" {
		message = "当前模型不支持该能力"
	}
	return NewModelError(ErrCodeModelCapabilityNotSupported, message)
}

func ModelCatalogMismatch(message string) error {
	if message == "" {
		message = "模型目录已更新，请重新选择"
	}
	return NewModelError(ErrCodeModelCatalogMismatch, message)
}

func InvalidModelSelection(message string) error {
	if message == "" {
		message = "无效的模型选择"
	}
	return NewModelError(ErrCodeInvalidModelSelection, message)
}
