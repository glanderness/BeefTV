package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 按轮撤销：助手一轮对话可能写多次画布，用户要能一次性回到「这轮开始之前」。
// 因此在转发对话之前先存一份轮前文档，轮结束时把这轮的变更记在同一条记录上。
// 撤销是把旧文档作为**新 revision** 写回（绝不回退版本号），画布的外部版本刷新才能接住。

const (
	AssistantTurnReasonNotFound      = "turn_not_found"
	AssistantTurnReasonNoChange      = "turn_has_no_change"
	AssistantTurnReasonAlreadyUndone = "turn_already_undone"
	AssistantTurnReasonCanvasChanged = "canvas_changed_since_turn"
)

// assistantTurnRetain 限制轮前快照的保留条数：撤销只面向最近的对话，
// 不能让快照在数据目录里无限增长。
const assistantTurnRetain = 64

// AssistantTurnError 承载稳定 reason，让 handler 直接投影成 409/404。
type AssistantTurnError struct {
	Reason  string
	Message string
}

func (e *AssistantTurnError) Error() string {
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Reason
}

// AssistantTurnChange 是一轮对话对画布的实际影响。
type AssistantTurnChange struct {
	RevisionBefore int64    `json:"revisionBefore"`
	RevisionAfter  int64    `json:"revisionAfter"`
	CreatedNodeIDs []string `json:"createdNodeIds"`
	UpdatedNodeIDs []string `json:"updatedNodeIds"`
	CreatedEdgeIDs []string `json:"createdEdgeIds"`
}

type assistantTurnRecord struct {
	TurnID         string               `json:"turnId"`
	UserID         string               `json:"userId"`
	CanvasID       string               `json:"canvasId"`
	RevisionBefore int64                `json:"revisionBefore"`
	CreatedAt      string               `json:"createdAt"`
	Undone         bool                 `json:"undone"`
	Change         *AssistantTurnChange `json:"change,omitempty"`
	Document       json.RawMessage      `json:"document"`
}

// assistantTurnMu 串行化同一数据目录上的快照读改写，避免并发轮次互相覆盖记录。
var assistantTurnMu sync.Mutex

func (s *Service) assistantTurnDir() string {
	return filepath.Join(s.dataDir, "assistant-turns")
}

// safeTurnID 只接受本进程生成的十六进制标识：文件名绝不接受调用方给的路径片段。
func safeTurnID(turnID string) string {
	trimmed := strings.TrimSpace(turnID)
	if trimmed == "" || len(trimmed) > 64 {
		return ""
	}
	for _, r := range trimmed {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') {
			continue
		}
		return ""
	}
	return trimmed
}

func (s *Service) assistantTurnPath(turnID string) string {
	safe := safeTurnID(turnID)
	if safe == "" {
		return ""
	}
	return filepath.Join(s.assistantTurnDir(), safe+".json")
}

// BeginAssistantTurn 在一轮对话开始前保存轮前画布文档，并返回轮前 revision。
func (s *Service) BeginAssistantTurn(userID, canvasID, turnID string) (int64, error) {
	path := s.assistantTurnPath(turnID)
	if path == "" {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonNotFound, Message: "轮次标识无效"}
	}
	raw, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return 0, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 0, err
	}
	revision := assistantDocRevision(doc)
	record := assistantTurnRecord{TurnID: safeTurnID(turnID), UserID: userID, CanvasID: canvasID,
		RevisionBefore: revision, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Document: raw}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	if err := s.writeAssistantTurn(path, record); err != nil {
		return 0, err
	}
	s.pruneAssistantTurns()
	return revision, nil
}

// RecordAssistantTurnChange 把这轮的实际变更记到轮记录上；没写过画布时直接丢弃快照。
func (s *Service) RecordAssistantTurnChange(turnID string, change *AssistantTurnChange) error {
	path := s.assistantTurnPath(turnID)
	if path == "" {
		return nil
	}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	record, err := readAssistantTurn(path)
	if err != nil {
		return nil // 轮前快照不存在（例如画布读失败）时不需要补记
	}
	if change == nil || change.RevisionAfter <= change.RevisionBefore {
		// 这一轮没改画布：轮记录要留下（撤销才能回答「这一轮没有改动」而不是「轮次不存在」），
		// 但轮前文档可以丢掉，避免为没有撤销价值的轮次占着整份画布。
		record.Change = nil
		record.Document = nil
		return s.writeAssistantTurn(path, record)
	}
	record.Change = change
	return s.writeAssistantTurn(path, record)
}

// UndoAssistantTurn 把轮前文档作为新版本写回，并把该轮标记为已撤销。
func (s *Service) UndoAssistantTurn(userID, canvasID, turnID string) (int64, error) {
	path := s.assistantTurnPath(turnID)
	if path == "" {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonNotFound, Message: "轮次不存在"}
	}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	record, err := readAssistantTurn(path)
	if err != nil || record.UserID != userID || record.CanvasID != canvasID {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonNotFound, Message: "轮次不存在"}
	}
	if record.Undone {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonAlreadyUndone, Message: "这一轮已经撤销过了"}
	}
	if record.Change == nil {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonNoChange, Message: "这一轮没有改动画布"}
	}
	current, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return 0, err
	}
	var currentDoc map[string]any
	if err := json.Unmarshal(current, &currentDoc); err != nil {
		return 0, err
	}
	currentRevision := assistantDocRevision(currentDoc)
	if currentRevision != record.Change.RevisionAfter {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonCanvasChanged, Message: "画布在这一轮之后又被改过，已停止撤销"}
	}
	var restored map[string]any
	if err := json.Unmarshal(record.Document, &restored); err != nil {
		return 0, err
	}
	restored["id"] = canvasID
	// 观察值是当前版本：撤销走和助手写入相同的 CAS 写入口，产生一个新版本。
	restored["revision"] = currentRevision
	encoded, err := json.Marshal(restored)
	if err != nil {
		return 0, err
	}
	summary, err := s.UpsertUserCanvasProject(userID, encoded)
	if err != nil {
		return 0, err
	}
	record.Undone = true
	if err := s.writeAssistantTurn(path, record); err != nil {
		return summary.Revision, nil
	}
	return summary.Revision, nil
}

func (s *Service) writeAssistantTurn(path string, record assistantTurnRecord) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".turn-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func readAssistantTurn(path string) (assistantTurnRecord, error) {
	var record assistantTurnRecord
	raw, err := os.ReadFile(path)
	if err != nil {
		return record, err
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return record, err
	}
	return record, nil
}

func (s *Service) pruneAssistantTurns() {
	entries, err := os.ReadDir(s.assistantTurnDir())
	if err != nil {
		return
	}
	type item struct {
		name string
		at   time.Time
	}
	items := make([]item, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, item{name: entry.Name(), at: info.ModTime()})
	}
	if len(items) <= assistantTurnRetain {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].at.After(items[j].at) })
	for _, stale := range items[assistantTurnRetain:] {
		_ = os.Remove(filepath.Join(s.assistantTurnDir(), stale.name))
	}
}

func assistantDocRevision(doc map[string]any) int64 {
	switch value := doc["revision"].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	case json.Number:
		if parsed, err := value.Int64(); err == nil {
			return parsed
		}
	}
	return 0
}
