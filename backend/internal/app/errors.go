package app

import (
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/modelcatalog"
)

// AppError 是 service 层对外公开的结构化错误；实现已迁到 kernel。
type AppError = kernel.AppError

func NewAppError(status int, message string) *AppError {
	return kernel.NewAppError(status, message)
}

func WrapAppError(status int, message string, cause error) *AppError {
	return kernel.WrapAppError(status, message, cause)
}

func RateLimited(message string) *AppError {
	return kernel.RateLimited(message)
}

func QuotaExceeded(message string) *AppError {
	return kernel.QuotaExceeded(message)
}

// AuthError 保留为兼容别名。
type AuthError = AppError

func BadAuthRequest(message string) *AuthError {
	return kernel.BadAuthRequest(message)
}

func NotFound(message string) *AuthError {
	return kernel.NotFound(message)
}

func Unauthorized(message string) *AuthError {
	return kernel.Unauthorized(message)
}

func Forbidden(message string) *AuthError {
	return kernel.Forbidden(message)
}

// ModelError 与错误码由 modelcatalog 拥有。类型别名保证 handler errors.As(*app.ModelError)
// 和 AppError.Reason 与领域返回值是同一动态类型，machineReason 不漂移。
type ModelErrorCode = modelcatalog.ModelErrorCode
type ModelError = modelcatalog.ModelError

const (
	ErrCodeModelCapabilityNotSupported = modelcatalog.ErrCodeModelCapabilityNotSupported
	ErrCodeModelRouteUnavailable       = modelcatalog.ErrCodeModelRouteUnavailable
	ErrCodeProviderRequestFailed       = modelcatalog.ErrCodeProviderRequestFailed
	ErrCodeModelCatalogMismatch        = modelcatalog.ErrCodeModelCatalogMismatch
	ErrCodeInvalidModelSelection       = modelcatalog.ErrCodeInvalidModelSelection
)
