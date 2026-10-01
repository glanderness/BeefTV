package assistantturns

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

// Service owns assistant business-round algorithms. pi owns model session
// history; this type never stores a transcript.
type Service struct {
	store          Store
	canvas         CanvasFactory
	jsonDir        string
	now            func() time.Time
	undoMarkerHook func() error
}

// New constructs the domain service. jsonDir is the legacy assistant-turns
// directory; files there are imported on the accessed ID only.
func New(store Store, canvas CanvasFactory, jsonDir string) *Service {
	return &Service{store: store, canvas: canvas, jsonDir: jsonDir, now: func() time.Time { return time.Now().UTC() }}
}

// WithUndoMarkerHook injects a failure after canvas restore and before the
// undone marker is written. Tests use it to prove the shared transaction
// rolls the canvas write back.
func (s *Service) WithUndoMarkerHook(fn func() error) *Service {
	if s == nil {
		return nil
	}
	clone := *s
	clone.undoMarkerHook = fn
	return &clone
}

func (s *Service) storeReady() bool {
	return s != nil && s.store != nil && s.store.Available()
}

func (s *Service) load(tx *gorm.DB, turnID string) (Record, error) {
	id := NormalizeTurnID(turnID)
	if id == "" {
		return Record{}, errInvalidID()
	}
	if s.storeReady() {
		row, err := s.store.Get(tx, id)
		if err == nil {
			return recordFromModel(row)
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return Record{}, err
		}
	}
	rec, err := s.importLegacyIfMissing(tx, id)
	if err != nil {
		return Record{}, err
	}
	return rec, nil
}

func (s *Service) persist(tx *gorm.DB, rec Record) error {
	if !s.storeReady() {
		return storeUnavailable()
	}
	return s.store.Save(tx, recordToModel(rec, s.now()))
}

func beginCollision() *Error {
	return &Error{Reason: ReasonIDCollision, Message: "同一轮次标识已用于不同的范围或身份"}
}

// Begin captures the pre-turn canvas document and verified references.
// Replaying the same ID with the same actor and scope returns the original
// snapshot revision. A different scope on that ID is refused. Legacy files
// are read-only migration inputs; this method never writes them.
func (s *Service) Begin(userID, canvasID, turnID string, input Input) (int64, error) {
	if err := requireActor(userID, canvasID); err != nil {
		return 0, err
	}
	id := NormalizeTurnID(turnID)
	if id == "" {
		return 0, errInvalidID()
	}
	if s.canvas == nil {
		return 0, errors.New("画布存储不可用")
	}
	if !s.storeReady() {
		return 0, storeUnavailable()
	}
	var rec Record
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		existing, found, resolveErr := s.resolveIdentity(tx, id)
		if resolveErr != nil {
			return resolveErr
		}
		if found {
			if !existing.sameBeginScope(userID, canvasID, input) {
				return beginCollision()
			}
			if _, getErr := s.store.Get(tx, id); errors.Is(getErr, gorm.ErrRecordNotFound) {
				if _, insErr := s.store.Insert(tx, recordToModel(existing, s.now())); insErr != nil {
					return insErr
				}
			} else if getErr != nil {
				return getErr
			}
			rec = existing
			return nil
		}
		raw, canvasErr := s.canvas.BoundTo(tx).UserCanvasProject(userID, canvasID)
		if canvasErr != nil {
			return canvasErr
		}
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		associatedAssets, associatedTasks := AssociatedReferences(raw)
		rec = Record{
			TurnID:              id,
			UserID:              userID,
			CanvasID:            canvasID,
			RevisionBefore:      DocumentRevision(doc),
			CreatedAt:           s.now(),
			State:               StateOpen,
			Document:            raw,
			SelectedNodeIDs:     uniqueSorted(input.SelectedNodeIDs),
			ReferencedAssetIDs:  uniqueSorted(input.AssetIDs),
			ReferencedCanvasIDs: uniqueSorted(input.CanvasIDs),
			AssociatedAssetIDs:  associatedAssets,
			AssociatedTaskIDs:   associatedTasks,
		}
		inserted, insErr := s.store.Insert(tx, recordToModel(rec, s.now()))
		if insErr != nil {
			return insErr
		}
		if inserted {
			return nil
		}
		existingRow, getErr := s.store.Get(tx, id)
		if getErr != nil {
			return getErr
		}
		existingRec, recErr := recordFromModel(existingRow)
		if recErr != nil {
			return recErr
		}
		if !existingRec.sameBeginScope(userID, canvasID, input) {
			return beginCollision()
		}
		rec = existingRec
		return nil
	})
	if err != nil {
		return 0, err
	}
	s.prune()
	return rec.RevisionBefore, nil
}

// ScopeForHost returns the verified range for an open, non-undone round
// owned by userID. ok is false when the round is missing, foreign, settled,
// or already undone.
func (s *Service) ScopeForHost(userID, turnID string) (Scope, bool, error) {
	if strings.TrimSpace(userID) == "" {
		return Scope{}, false, nil
	}
	if NormalizeTurnID(turnID) == "" {
		return Scope{}, false, nil
	}
	rec, err := s.load(nil, turnID)
	if err != nil {
		if isMissing(err) {
			return Scope{}, false, nil
		}
		var turnErr *Error
		if errors.As(err, &turnErr) && turnErr.Reason == ReasonNotFound {
			return Scope{}, false, nil
		}
		return Scope{}, false, err
	}
	if rec.UserID != userID || rec.Undone || rec.effectiveState() != StateOpen {
		return Scope{}, false, nil
	}
	return Scope{
		CanvasID:  rec.CanvasID,
		AssetIDs:  uniqueSorted(append(append([]string{}, rec.ReferencedAssetIDs...), rec.AssociatedAssetIDs...)),
		CanvasIDs: uniqueSorted(rec.ReferencedCanvasIDs),
		TaskIDs:   uniqueSorted(rec.AssociatedTaskIDs),
	}, true, nil
}

// Finalize settles an open round from this round's succeeded receipts.
// Receipt query failure keeps the snapshot. Already settled or undone rounds
// are left unchanged.
func (s *Service) Finalize(turnID string) error {
	id := NormalizeTurnID(turnID)
	if id == "" {
		return nil
	}
	if !s.storeReady() {
		_, err := s.readLegacyFile(id)
		if isMissing(err) {
			return nil
		}
		if err != nil {
			return err
		}
		return storeUnavailable()
	}
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		rec, err := s.load(tx, id)
		if err != nil {
			if isMissing(err) {
				return nil
			}
			var turnErr *Error
			if errors.As(err, &turnErr) && (turnErr.Reason == ReasonNotFound || turnErr.Reason == ReasonCorruptFile) {
				if turnErr.Reason == ReasonCorruptFile {
					return err
				}
				return nil
			}
			return err
		}
		if rec.Undone || rec.effectiveState() == StateSettled {
			return nil
		}
		receipts, err := s.store.SucceededByTurn(tx, rec.UserID, rec.TurnID)
		if err != nil {
			return err
		}
		change, err := changeFromReceipts(rec, receipts)
		if err != nil {
			return err
		}
		rec.State = StateSettled
		rec.Change = change
		if change == nil {
			rec.Document = nil
		}
		return s.persist(tx, rec)
	})
}

// History projects durable receipts for an owner-scoped round. Open rounds
// reconstruct change from receipts without settling.
func (s *Service) History(userID, canvasID, turnID string) (*HistoryState, error) {
	if NormalizeTurnID(turnID) == "" {
		return nil, nil
	}
	if err := requireActor(userID, canvasID); err != nil {
		return nil, nil
	}
	rec, err := s.load(nil, turnID)
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		var turnErr *Error
		if errors.As(err, &turnErr) && turnErr.Reason == ReasonNotFound {
			return nil, nil
		}
		return nil, err
	}
	if rec.UserID != userID || rec.CanvasID != canvasID {
		return nil, nil
	}
	change := rec.Change
	if rec.effectiveState() == StateOpen && !rec.Undone {
		if !s.storeReady() {
			return nil, storeUnavailable()
		}
		receipts, err := s.store.SucceededByTurn(nil, rec.UserID, rec.TurnID)
		if err != nil {
			return nil, err
		}
		change, err = changeFromReceipts(rec, receipts)
		if err != nil {
			return nil, err
		}
	}
	return &HistoryState{Change: change, Undone: rec.Undone}, nil
}

// Undone reports whether the owner-scoped round carries a durable undo marker.
func (s *Service) Undone(userID, canvasID, turnID string) bool {
	if err := requireActor(userID, canvasID); err != nil {
		return false
	}
	if NormalizeTurnID(turnID) == "" {
		return false
	}
	rec, err := s.load(nil, turnID)
	return err == nil && rec.UserID == userID && rec.CanvasID == canvasID && rec.Undone
}

// ChangeFromReceipts is the receipt reconstruction used by Finalize and Undo.
func (s *Service) ChangeFromReceipts(rec Record) (*Change, error) {
	if strings.TrimSpace(rec.TurnID) == "" {
		return nil, errors.New("助手操作回执不可用，已保留撤销快照")
	}
	if !s.storeReady() {
		return nil, storeUnavailable()
	}
	receipts, err := s.store.SucceededByTurn(nil, rec.UserID, rec.TurnID)
	if err != nil {
		return nil, err
	}
	return changeFromReceipts(rec, receipts)
}

func (s *Service) prune() {
	if !s.storeReady() {
		return
	}
	ids, err := s.store.ListPrunable(nil, retainSettled)
	if err != nil || len(ids) == 0 {
		return
	}
	_ = s.store.CompactDocuments(nil, ids)
}

// Load is used by app tests that previously inspected JSON files.
func (s *Service) Load(turnID string) (Record, error) {
	return s.load(nil, turnID)
}

// VerifyOpenTurnInTx must run INSIDE the operation transaction that writes
// the canvas mutation and AgentOpRecord. An external ScopeForHost preflight
// does not close the settle/write race: Finalize can settle between preflight
// and the operation commit.
//
// Signature for Lead / common-ops:
//
//	func (s *assistantturns.Service) VerifyOpenTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error
//
// Call with the same tx used to insert agent_op_records. Empty turnID means
// the write is not turn-attributed (CLI/MCP) and is allowed. A non-empty
// turnID takes a write lock on the round row and refuses settled, undone,
// foreign, or canvas-mismatched rounds.
func (s *Service) VerifyOpenTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error {
	if strings.TrimSpace(turnID) == "" {
		return nil
	}
	if tx == nil {
		return errors.New("助手回合校验必须在操作事务内执行")
	}
	if err := requireActor(userID, canvasID); err != nil {
		return err
	}
	id := NormalizeTurnID(turnID)
	if id == "" {
		return errInvalidID()
	}
	if !s.storeReady() {
		return storeUnavailable()
	}
	rec, err := s.lockOpenTurn(tx, userID, turnID, canvasID)
	if err != nil {
		return err
	}
	_ = rec
	return nil
}
