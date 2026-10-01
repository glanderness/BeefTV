package creation

import (
	"errors"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/repository"
)

const (
	msgLeaseExpired      = "执行控制权已过期，请在当前页面重新接管"
	msgEpochChanged      = "执行代次已变化"
	msgUnknownAction     = "未知创作操作"
	msgMissingClientKey  = "缺少稳定会话键"
	msgClientKeyConflict = "同一会话键的内容不同"
	msgNotFound          = "创作记录不存在或无权访问"
	msgStateChanged      = "创作状态已变化，请重新读取后继续"
	msgActiveTaskLimit   = "同时排队或运行的任务已达到上限"
	msgModelUpdated      = "模型已更新或停用，请重新准备执行项"
	msgModelSelfConfirm  = "确认必须由当前页面完成，不能由模型自行批准"
	msgUnknownReceipt    = "生成提交状态未知，请查看原任务；不会再次提交"
	msgJSONLimit         = "创作内容超过限制或格式无效"
	msgSecretsInRecord   = "创作记录不能包含密钥、内嵌媒体或临时签名链接"
	unknownReceiptFlag   = "unknownAdmissionReceipt"
)

// ErrUnknownReceipt means a submit already produced an unknown upstream
// admission result. Callers must not start another paid attempt.
var ErrUnknownReceipt = kernel.NewAppError(kernel.CodeConflict, msgUnknownReceipt)

func Conflict(message string) error {
	return kernel.NewAppError(kernel.CodeConflict, message)
}

func MapError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, repository.ErrActiveTaskLimit) {
		return kernel.BadAuthRequest(msgActiveTaskLimit)
	}
	if errors.Is(err, repository.ErrLogicalModelUnavailable) {
		return Conflict(msgModelUpdated)
	}
	if errors.Is(err, repository.ErrCreationConflict) {
		return Conflict(msgStateChanged)
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.NotFound(msgNotFound)
	}
	if errors.Is(err, ErrUnknownReceipt) {
		return ErrUnknownReceipt
	}
	return err
}

func IsUnknownReceipt(err error) bool {
	return errors.Is(err, ErrUnknownReceipt)
}
