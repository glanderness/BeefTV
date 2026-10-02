package assistantturns

import (
	"encoding/json"
	"errors"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (s *Service) lockOpenTurn(tx *gorm.DB, userID, turnID, canvasID string) (Record, error) {
	id := NormalizeTurnID(turnID)
	var rec Record
	var row model.AssistantTurn
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("turn_id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		imported, importErr := s.importLegacyIfMissing(tx, id)
		if importErr != nil {
			if isMissing(importErr) {
				return Record{}, &Error{Reason: ReasonNotOpen, Message: "这一轮不存在或已结束"}
			}
			return Record{}, importErr
		}
		rec = imported
	} else if err != nil {
		return Record{}, err
	} else {
		decoded, recErr := recordFromModel(&row)
		if recErr != nil {
			return Record{}, recErr
		}
		rec = decoded
	}
	if rec.UserID != userID || rec.CanvasID != canvasID || rec.Undone || rec.effectiveState() != StateOpen {
		return Record{}, &Error{Reason: ReasonNotOpen, Message: "这一轮不存在或已结束"}
	}
	result := tx.Model(&model.AssistantTurn{}).
		Where("turn_id = ? AND user_id = ? AND canvas_id = ? AND state = ? AND undone = ?", id, userID, canvasID, StateOpen, false).
		Update("updated_at", s.now())
	if result.Error != nil {
		return Record{}, result.Error
	}
	if result.RowsAffected != 1 {
		return Record{}, &Error{Reason: ReasonNotOpen, Message: "这一轮不存在或已结束"}
	}
	return rec, nil
}

// Undo restores the pre-turn document as a new canvas revision and marks the
// round undone in the same transaction. A marker-write failure rolls the
// canvas restore back.
func (s *Service) Undo(userID, canvasID, turnID string) (int64, error) {
	if err := requireActor(userID, canvasID); err != nil {
		return 0, err
	}
	id := NormalizeTurnID(turnID)
	if id == "" {
		return 0, errNotFound()
	}
	if !s.storeReady() {
		return 0, storeUnavailable()
	}
	if s.canvas == nil {
		return 0, errors.New("画布存储不可用")
	}
	var restoredRevision int64
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		rec, err := s.load(tx, id)
		if err != nil {
			if isMissing(err) {
				return errNotFound()
			}
			return err
		}
		if rec.UserID != userID || rec.CanvasID != canvasID {
			return errNotFound()
		}
		if rec.Undone {
			return &Error{Reason: ReasonAlreadyUndone, Message: "这一轮已经撤销过了"}
		}
		if rec.Change == nil {
			receipts, receiptErr := s.store.SucceededByTurn(tx, rec.UserID, rec.TurnID)
			if receiptErr != nil {
				return receiptErr
			}
			change, receiptErr := changeFromReceipts(rec, receipts)
			if receiptErr != nil {
				return receiptErr
			}
			if change != nil {
				rec.Change = change
				if err := s.persist(tx, rec); err != nil {
					return err
				}
			}
		}
		if rec.Change == nil {
			return &Error{Reason: ReasonNoChange, Message: "这一轮没有改动画布"}
		}
		session := s.canvas.BoundTo(tx)
		current, err := session.UserCanvasProject(userID, canvasID)
		if err != nil {
			return err
		}
		var currentDoc map[string]any
		if err := json.Unmarshal(current, &currentDoc); err != nil {
			return err
		}
		currentRevision := DocumentRevision(currentDoc)
		if currentRevision != rec.Change.RevisionAfter || rec.Change.RevisionBefore != rec.RevisionBefore {
			return &Error{Reason: ReasonCanvasChanged, Message: "画布在这一轮之后又被改过，已停止撤销"}
		}
		var restored map[string]any
		if err := json.Unmarshal(rec.Document, &restored); err != nil {
			return err
		}
		singleWrite := currentRevision == rec.RevisionBefore+1
		if singleWrite {
			if !MatchesChange(restored, currentDoc, rec.Change) {
				return &Error{Reason: ReasonCanvasChanged, Message: "无法安全撤销这一轮，画布内容已保留"}
			}
		} else {
			ops, opErr := s.store.OpsByIDs(tx, rec.UserID, rec.Change.OperationIDs)
			if opErr != nil {
				return opErr
			}
			if !OperationsCoverSpan(ops, rec.CanvasID, rec.Change.OperationIDs, rec.RevisionBefore, currentRevision) {
				return &Error{Reason: ReasonCanvasChanged, Message: "无法安全撤销这一轮，画布内容已保留"}
			}
		}
		restored["id"] = canvasID
		restored["revision"] = currentRevision
		encoded, err := json.Marshal(restored)
		if err != nil {
			return err
		}
		revision, err := session.UpsertUserCanvasProject(userID, encoded)
		if err != nil {
			return err
		}
		if s.undoMarkerHook != nil {
			if hookErr := s.undoMarkerHook(); hookErr != nil {
				return hookErr
			}
		}
		rec.Undone = true
		if err := s.persist(tx, rec); err != nil {
			return err
		}
		restoredRevision = revision
		return nil
	})
	if err != nil {
		return 0, err
	}
	return restoredRevision, nil
}
