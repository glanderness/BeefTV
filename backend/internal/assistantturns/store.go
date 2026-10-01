package assistantturns

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// Store is the SQLite-backed round ledger. Callers pass a transaction when
// the round write must share a commit with canvas mutation.
type Store interface {
	Available() bool
	DB() *gorm.DB
	Get(tx *gorm.DB, turnID string) (*model.AssistantTurn, error)
	Insert(tx *gorm.DB, row *model.AssistantTurn) (bool, error)
	Save(tx *gorm.DB, row *model.AssistantTurn) error
	Delete(tx *gorm.DB, turnIDs []string) error
	ListPrunable(tx *gorm.DB, retain int) ([]string, error)
	CountReceipts(tx *gorm.DB, turnID string) (int64, error)
	SucceededByTurn(tx *gorm.DB, userID, turnID string) ([]model.AgentOpRecord, error)
	OpsByIDs(tx *gorm.DB, userID string, ids []string) ([]model.AgentOpRecord, error)
}

type gormStore struct {
	repo *repository.Repository
}

// NewStore binds the round ledger to a workspace repository.
func NewStore(repo *repository.Repository) Store {
	if repo == nil {
		return gormStore{}
	}
	return gormStore{repo: repo}
}

func (s gormStore) Available() bool { return s.repo != nil && s.repo.DB() != nil }

func (s gormStore) DB() *gorm.DB {
	if s.repo == nil {
		return nil
	}
	return s.repo.DB()
}

func (s gormStore) Get(tx *gorm.DB, turnID string) (*model.AssistantTurn, error) {
	return s.repo.AssistantTurnByID(tx, turnID)
}

func (s gormStore) Insert(tx *gorm.DB, row *model.AssistantTurn) (bool, error) {
	return s.repo.InsertAssistantTurn(tx, row)
}

func (s gormStore) Save(tx *gorm.DB, row *model.AssistantTurn) error {
	return s.repo.SaveAssistantTurn(tx, row)
}

func (s gormStore) Delete(tx *gorm.DB, turnIDs []string) error {
	return s.repo.DeleteAssistantTurns(tx, turnIDs)
}

func (s gormStore) ListPrunable(tx *gorm.DB, retain int) ([]string, error) {
	return s.repo.ListPrunableAssistantTurns(tx, retain)
}

func (s gormStore) CountReceipts(tx *gorm.DB, turnID string) (int64, error) {
	return s.repo.CountAgentOpReceiptsByTurn(tx, turnID)
}

func (s gormStore) SucceededByTurn(tx *gorm.DB, userID, turnID string) ([]model.AgentOpRecord, error) {
	return s.repo.SucceededAgentOpsByTurn(tx, userID, turnID)
}

func (s gormStore) OpsByIDs(tx *gorm.DB, userID string, ids []string) ([]model.AgentOpRecord, error) {
	return s.repo.AgentOpsByIDs(tx, userID, ids)
}

func encodeStringList(values []string) string {
	normalized := uniqueSorted(values)
	if len(normalized) == 0 {
		return ""
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func decodeStringList(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	var values []string
	if json.Unmarshal([]byte(trimmed), &values) != nil {
		return nil
	}
	return uniqueSorted(values)
}

func recordFromModel(row *model.AssistantTurn) Record {
	if row == nil {
		return Record{}
	}
	rec := Record{
		TurnID:              row.TurnID,
		UserID:              row.UserID,
		CanvasID:            row.CanvasID,
		RevisionBefore:      row.RevisionBefore,
		CreatedAt:           row.CreatedAt,
		State:               row.State,
		SelectedNodeIDs:     decodeStringList(row.SelectedNodeIDs),
		ReferencedAssetIDs:  decodeStringList(row.ReferencedAssetIDs),
		ReferencedCanvasIDs: decodeStringList(row.ReferencedCanvasIDs),
		AssociatedAssetIDs:  decodeStringList(row.AssociatedAssetIDs),
		AssociatedTaskIDs:   decodeStringList(row.AssociatedTaskIDs),
		Undone:              row.Undone,
	}
	if strings.TrimSpace(row.Document) != "" {
		rec.Document = json.RawMessage(row.Document)
	}
	if strings.TrimSpace(row.ChangeJSON) != "" {
		var change Change
		if json.Unmarshal([]byte(row.ChangeJSON), &change) == nil {
			rec.Change = &change
		}
	}
	return rec
}

func recordToModel(rec Record, now time.Time) *model.AssistantTurn {
	row := &model.AssistantTurn{
		TurnID:              rec.TurnID,
		UserID:              rec.UserID,
		CanvasID:            rec.CanvasID,
		RevisionBefore:      rec.RevisionBefore,
		CreatedAt:           rec.CreatedAt,
		UpdatedAt:           now,
		State:               rec.effectiveState(),
		SelectedNodeIDs:     encodeStringList(rec.SelectedNodeIDs),
		ReferencedAssetIDs:  encodeStringList(rec.ReferencedAssetIDs),
		ReferencedCanvasIDs: encodeStringList(rec.ReferencedCanvasIDs),
		AssociatedAssetIDs:  encodeStringList(rec.AssociatedAssetIDs),
		AssociatedTaskIDs:   encodeStringList(rec.AssociatedTaskIDs),
		Undone:              rec.Undone,
		Document:            string(rec.Document),
	}
	if rec.CreatedAt.IsZero() {
		row.CreatedAt = now
	}
	if rec.Change != nil {
		if raw, err := json.Marshal(rec.Change); err == nil {
			row.ChangeJSON = string(raw)
		}
	}
	return row
}

func storeUnavailable() error {
	return errors.New("助手操作回执不可用，已保留撤销快照")
}
