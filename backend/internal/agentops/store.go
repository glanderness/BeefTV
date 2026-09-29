package agentops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

// Store 负责操作记录的持久化去重。它和业务写入共用同一个数据库与同一个事务：
// 只有画布写入与操作记录一起提交，才不会出现「记录写了但业务没写」的假幂等。
type Store struct {
	db *gorm.DB
}

func NewStore(db *gorm.DB) *Store { return &Store{db: db} }

func (s *Store) Available() bool { return s != nil && s.db != nil }

// PayloadHash 是幂等键的组成部分：同 opId 同 payload 才允许回读原结果。
func PayloadHash(op string, payload []byte) string {
	sum := sha256.Sum256(append([]byte(op+"\x00"), payload...))
	return hex.EncodeToString(sum[:])
}

// RunOutcome 描述一次执行是真正执行了还是回读了历史结果。
type RunOutcome struct {
	Result   []byte
	Replayed bool
}

// Run 在一个事务里执行 fn，并用 opId 做持久化去重。
// opId 为空表示调用方不需要幂等保证（只读操作）。
func (s *Store) Run(ctx context.Context, userID, opID, op, payloadHash string, fn func(tx *gorm.DB) ([]byte, error)) (RunOutcome, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	db := s.db.WithContext(ctx)
	if strings.TrimSpace(opID) == "" {
		out, err := fn(db)
		return RunOutcome{Result: out}, err
	}
	if !s.Available() {
		return RunOutcome{}, newError(CodeInternal, "op_store_unavailable", "操作记录存储不可用", nil)
	}
	var outcome RunOutcome
	err := db.Transaction(func(tx *gorm.DB) error {
		record := model.AgentOpRecord{OpID: opID, UserID: userID, Op: op, PayloadHash: payloadHash, Status: "running"}
		if err := tx.Create(&record).Error; err != nil {
			if !isDuplicateKey(err) {
				return AsError(err) // 其他数据库错误不能被当成“重复”而回放
			}
			var existing model.AgentOpRecord
			// 命名空间：只在本用户自己的操作记录里回放，绝不跨用户/越权读取他人结果
			if findErr := tx.Where("user_id = ? AND op_id = ?", userID, opID).First(&existing).Error; findErr != nil {
				return AsError(err)
			}
			if existing.Status != "succeeded" {
				return Conflict("operation_in_progress",
					"同一操作正在执行或上次未成功，未回放结果", map[string]any{"opId": opID, "status": existing.Status})
			}
			if existing.PayloadHash != payloadHash || existing.Op != op {
				return Conflict("operation_id_reused_with_different_payload",
					"同一操作 ID 已用于不同的请求内容；请换用新的操作 ID",
					map[string]any{"opId": opID, "existingOp": existing.Op})
			}
			outcome = RunOutcome{Result: []byte(existing.ResultJSON), Replayed: true}
			return nil
		}
		out, runErr := fn(tx)
		if runErr != nil {
			return runErr // 回滚：失败的操作不留下幂等记录
		}
		if err := tx.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, opID).
			Updates(map[string]any{"status": "succeeded", "result_json": string(out)}).Error; err != nil {
			return AsError(err)
		}
		outcome = RunOutcome{Result: out}
		return nil
	})
	if err != nil {
		var opErr *Error
		if errors.As(err, &opErr) {
			return RunOutcome{}, opErr
		}
		return RunOutcome{}, AsError(err)
	}
	return outcome, nil
}

// isDuplicateKey 只把真正的唯一约束冲突当成“已存在”，其余数据库错误照实上报。
func isDuplicateKey(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	var coder interface{ Code() int }
	if errors.As(err, &coder) {
		switch coder.Code() {
		case 1555, 2067: // SQLITE_CONSTRAINT_PRIMARYKEY / SQLITE_CONSTRAINT_UNIQUE
			return true
		}
	}
	return strings.Contains(strings.ToUpper(err.Error()), "UNIQUE CONSTRAINT FAILED")
}
