package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
)

// 按轮撤销：转发对话之前先存轮前文档，轮结束时记录变更。
// 只写了一次时，用文档差异核对摘要；写了多次时，必须用这轮自己的操作回执证明
// 中间每个版本都属于这一轮，否则拒绝撤销，避免抹掉轮中的外部编辑。
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
	OperationIDs   []string `json:"operationIds,omitempty"`
}

// AssistantTurnInput 是一轮对话开始时后端已经验证过的显式输入。
// 额外引用只能由界面请求、经后端校验归属后落在这里，模型无法自授。
type AssistantTurnInput struct {
	SelectedNodeIDs []string
	AssetIDs        []string
	CanvasIDs       []string
}

// AssistantTurnScope 是一轮对话被后端验证过的可读写范围。
// 写入时后端只从这个记录读取范围，不接受调用方自报的列表。
type AssistantTurnScope struct {
	CanvasID  string
	AssetIDs  []string
	CanvasIDs []string
	TaskIDs   []string
}

// 回合状态：open 期间的写入才会被记到这一轮上，settled 之后不再接受归属，
// 撤销（undone）也不清空已确认的证据。
const (
	assistantTurnStateOpen    = "open"
	assistantTurnStateSettled = "settled"
)

type assistantTurnRecord struct {
	TurnID         string `json:"turnId"`
	UserID         string `json:"userId"`
	CanvasID       string `json:"canvasId"`
	RevisionBefore int64  `json:"revisionBefore"`
	CreatedAt      string `json:"createdAt"`
	// State 为空表示旧记录：按已结算处理，只允许按回执补算，不接受新的写入归属。
	State               string               `json:"state,omitempty"`
	SelectedNodeIDs     []string             `json:"selectedNodeIds,omitempty"`
	ReferencedAssetIDs  []string             `json:"referencedAssetIds,omitempty"`
	ReferencedCanvasIDs []string             `json:"referencedCanvasIds,omitempty"`
	AssociatedAssetIDs  []string             `json:"associatedAssetIds,omitempty"`
	AssociatedTaskIDs   []string             `json:"associatedTaskIds,omitempty"`
	Undone              bool                 `json:"undone"`
	Change              *AssistantTurnChange `json:"change,omitempty"`
	Document            json.RawMessage      `json:"document"`
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

// ValidAssistantTurnID 判断标识形状是否可能是本进程生成的轮次标识。
// 形状只是第一道过滤：真正的归属还要读回合记录并校验用户、画布与状态。
func ValidAssistantTurnID(turnID string) bool {
	return safeTurnID(turnID) != ""
}

func (s *Service) assistantTurnPath(turnID string) string {
	safe := safeTurnID(turnID)
	if safe == "" {
		return ""
	}
	return filepath.Join(s.assistantTurnDir(), safe+".json")
}

// BeginAssistantTurn 在一轮对话开始前保存轮前画布文档，并返回轮前 revision。
// 同时把后端验证过的引用与从画布解析出的关联素材/任务一起持久化：
// 之后的操作入口只按这个记录读范围，不再信任任何调用方自报的 header。
func (s *Service) BeginAssistantTurn(userID, canvasID, turnID string, input AssistantTurnInput) (int64, error) {
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
	associatedAssets, associatedTasks := canvasAssociatedReferences(raw)
	record := assistantTurnRecord{TurnID: safeTurnID(turnID), UserID: userID, CanvasID: canvasID,
		RevisionBefore: revision, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State: assistantTurnStateOpen, Document: raw,
		SelectedNodeIDs:     uniqueSorted(input.SelectedNodeIDs),
		ReferencedAssetIDs:  uniqueSorted(input.AssetIDs),
		ReferencedCanvasIDs: uniqueSorted(input.CanvasIDs),
		AssociatedAssetIDs:  associatedAssets,
		AssociatedTaskIDs:   associatedTasks}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	if err := s.writeAssistantTurn(path, record); err != nil {
		return 0, err
	}
	s.pruneAssistantTurns()
	return revision, nil
}

// AssistantTurnScopeForHost 读取一轮对话被后端验证过的范围。
// 只有内置助手宿主会调用它：外部客户端拿不到这样的记录，也无法自报归属。
// 第二个返回值是 false 时表示这一轮不存在、不属于该用户，或已经结算/撤销。
func (s *Service) AssistantTurnScopeForHost(userID, turnID string) (AssistantTurnScope, bool, error) {
	path := s.assistantTurnPath(turnID)
	if path == "" {
		return AssistantTurnScope{}, false, nil
	}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	record, err := readAssistantTurn(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return AssistantTurnScope{}, false, nil
		}
		return AssistantTurnScope{}, false, err
	}
	if record.UserID != userID || record.Undone || record.State != assistantTurnStateOpen {
		return AssistantTurnScope{}, false, nil
	}
	return AssistantTurnScope{
		CanvasID:  record.CanvasID,
		AssetIDs:  uniqueSorted(append(append([]string{}, record.ReferencedAssetIDs...), record.AssociatedAssetIDs...)),
		CanvasIDs: uniqueSorted(record.ReferencedCanvasIDs),
		TaskIDs:   uniqueSorted(record.AssociatedTaskIDs),
	}, true, nil
}

// canvasAssociatedReferences 从真实画布文档解析「当前画布关联的素材与任务」。
// 素材沿用画布既有的媒体引用解析（节点与时间线），任务取节点上已登记生成批次的 taskId，
// 不新造第二套引用结构。
func canvasAssociatedReferences(raw json.RawMessage) ([]string, []string) {
	assets := []string{}
	if references, err := canvas.MediaAssetReferences(raw); err == nil {
		for _, reference := range references {
			if id := strings.TrimSpace(reference.AssetID); id != "" {
				assets = append(assets, id)
			}
		}
	}
	tasks := []string{}
	var payload struct {
		Nodes []struct {
			Metadata struct {
				GenerationBatch struct {
					TaskID       string `json:"taskId"`
					Continuation struct {
						TaskID string `json:"taskId"`
					} `json:"agentGenerationContinuation"`
				} `json:"generationBatch"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if json.Unmarshal(raw, &payload) == nil {
		for _, node := range payload.Nodes {
			if id := strings.TrimSpace(node.Metadata.GenerationBatch.TaskID); id != "" {
				tasks = append(tasks, id)
			}
			if id := strings.TrimSpace(node.Metadata.GenerationBatch.Continuation.TaskID); id != "" {
				tasks = append(tasks, id)
			}
		}
	}
	return uniqueSorted(assets), uniqueSorted(tasks)
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	sort.Strings(out)
	return out
}

// FinalizeAssistantTurn 结算一轮对话：从本轮自己的写操作回执重建变更摘要并落盘。
//
// 这一步刻意不依赖浏览器流和宿主最终消息：回执与业务写入在同一个事务里提交，
// 所以中途断开、用户取消、宿主重启之后，已经落地的操作依然可追溯、可撤销。
// 本轮没有推进画布版本时保留轮记录但不留轮前文档（撤销要能回答「这一轮没有改动」）。
func (s *Service) FinalizeAssistantTurn(turnID string) error {
	path := s.assistantTurnPath(turnID)
	if path == "" {
		return nil
	}
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	record, err := readAssistantTurn(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // 轮前快照不存在（例如画布读失败）时不需要补记
		}
		return err // 记录损坏/不可读：保留现场并如实上报，绝不覆盖成「没有改动」
	}
	if record.Undone || record.State == assistantTurnStateSettled {
		// 已撤销或已结算的回合不能被重复结算清空：撤销证据和变更摘要都要留着。
		return nil
	}
	change, err := s.assistantTurnChangeFromReceipts(record)
	if err != nil {
		// 查询失败时保留快照：把未知错误当成「没有改动」会让轮前文档被清空、撤销失效。
		return err
	}
	record.State = assistantTurnStateSettled
	record.Change = change
	if change == nil {
		record.Document = nil
	}
	return s.writeAssistantTurn(path, record)
}

// assistantTurnChangeFromReceipts 只用带本轮标识、且确实推进了画布版本的写操作回执
// 组成变更摘要。回执里的 canvasId 必须与轮记录一致，因此伪造的轮标识无法把别的画布写进来。
// 查询失败必须返回错误，调用方要保留轮前快照，不能把未知错误当成「这一轮没有改动」。
func (s *Service) assistantTurnChangeFromReceipts(record assistantTurnRecord) (*AssistantTurnChange, error) {
	if s == nil || s.Database() == nil || strings.TrimSpace(record.TurnID) == "" {
		return nil, errors.New("助手操作回执不可用，已保留撤销快照")
	}
	var receipts []model.AgentOpRecord
	if err := s.Database().Where("user_id = ? AND turn_id = ? AND status = ?", record.UserID, record.TurnID, "succeeded").
		Find(&receipts).Error; err != nil {
		return nil, err
	}
	type step struct {
		revision int64
		opID     string
		op       string
		payload  map[string]any
	}
	steps := make([]step, 0, len(receipts))
	for _, receipt := range receipts {
		var payload map[string]any
		if json.Unmarshal([]byte(receipt.ResultJSON), &payload) != nil {
			return nil, errors.New("助手操作回执损坏，已保留撤销快照")
		}
		if got, _ := payload["canvasId"].(string); got != record.CanvasID {
			return nil, errors.New("助手操作回执的画布归属不一致，已保留撤销快照")
		}
		if receipt.Op == "canvas.edge.create" && payload["created"] != true {
			continue // 重复边的回执不是写入，绝不能替外部修改认领版本。
		}
		revision, ok := jsonWholeNumber(payload["revision"])
		if !ok || revision <= record.RevisionBefore {
			continue // 没有推进版本（例如重复连线幂等返回）不算本轮改动
		}
		steps = append(steps, step{revision: revision, opID: receipt.OpID, op: receipt.Op, payload: payload})
	}
	if len(steps) == 0 {
		return nil, nil
	}
	sort.Slice(steps, func(i, j int) bool { return steps[i].revision < steps[j].revision })
	change := &AssistantTurnChange{RevisionBefore: record.RevisionBefore}
	for _, item := range steps {
		// 每个版本只认一次：同一版本上的幂等重放（例如重复连线原样返回）
		// 不推进 revision，也不能被记成第二个「本轮改动」——否则按轮撤销会因为
		// 同一版本出现两条回执而判定「中间有无法归属的写入」并拒绝撤销。
		if item.revision <= change.RevisionAfter {
			continue
		}
		change.RevisionAfter = item.revision
		change.OperationIDs = append(change.OperationIDs, item.opID)
		switch item.op {
		case "canvas.nodes.create":
			for _, raw := range docItems(item.payload["created"]) {
				if id, _ := raw["id"].(string); id != "" {
					change.CreatedNodeIDs = append(change.CreatedNodeIDs, id)
				}
			}
		case "canvas.node.update":
			if id, _ := item.payload["nodeId"].(string); id != "" {
				change.UpdatedNodeIDs = append(change.UpdatedNodeIDs, id)
			}
		case "canvas.edge.create":
			if created, _ := item.payload["created"].(bool); created {
				if id, _ := item.payload["edgeId"].(string); id != "" {
					change.CreatedEdgeIDs = append(change.CreatedEdgeIDs, id)
				}
			}
		}
	}
	if change.RevisionAfter <= change.RevisionBefore {
		return nil, nil
	}
	return change, nil
}

func docItems(value any) []map[string]any {
	items, _ := value.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			out = append(out, object)
		}
	}
	return out
}

// AssistantTurnUndone reads the same scoped durable receipt used by undo.
func (s *Service) AssistantTurnUndone(userID, canvasID, turnID string) bool {
	assistantTurnMu.Lock()
	defer assistantTurnMu.Unlock()
	record, err := readAssistantTurn(s.assistantTurnPath(turnID))
	return err == nil && record.UserID == userID && record.CanvasID == canvasID && record.Undone
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
		// 结算没有跑完（例如后端在回合中途重启）：用回执补算一次，
		// 不让「已经落地的写入」因为一次进程退出变成不可撤销。
		change, receiptErr := s.assistantTurnChangeFromReceipts(record)
		if receiptErr != nil {
			return 0, receiptErr // 保留快照：未知错误不能当成「没有改动」
		}
		if change != nil {
			record.Change = change
			if err := s.writeAssistantTurn(path, record); err != nil {
				return 0, err
			}
		}
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
	if currentRevision != record.Change.RevisionAfter || record.Change.RevisionBefore != record.RevisionBefore {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonCanvasChanged, Message: "画布在这一轮之后又被改过，已停止撤销"}
	}
	var restored map[string]any
	if err := json.Unmarshal(record.Document, &restored); err != nil {
		return 0, err
	}
	singleWrite := currentRevision == record.RevisionBefore+1
	if singleWrite {
		if !assistantTurnMatchesChange(restored, currentDoc, record.Change) {
			return 0, &AssistantTurnError{Reason: AssistantTurnReasonCanvasChanged, Message: "无法安全撤销这一轮，画布内容已保留"}
		}
	} else if !s.assistantOperationsCoverSpan(record.UserID, record.CanvasID, record.Change.OperationIDs, record.RevisionBefore, currentRevision) {
		return 0, &AssistantTurnError{Reason: AssistantTurnReasonCanvasChanged, Message: "无法安全撤销这一轮，画布内容已保留"}
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

// assistantOperationsCoverSpan 要求这轮列出的成功操作正好覆盖 before 与 after 之间的每个版本，
// 并且这些回执都属于同一张画布。缺一版就说明中间有无法归属的写入。
func (s *Service) assistantOperationsCoverSpan(userID, canvasID string, ids []string, before, after int64) bool {
	if s == nil || after <= before || len(ids) == 0 || s.Database() == nil {
		return false
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	var records []model.AgentOpRecord
	if err := s.Database().Where("user_id = ? AND op_id IN ?", userID, ids).Find(&records).Error; err != nil || len(records) != len(ids) {
		return false
	}
	covered := make(map[int64]bool, len(records))
	for _, record := range records {
		if record.Status != "succeeded" {
			return false
		}
		var payload map[string]any
		if json.Unmarshal([]byte(record.ResultJSON), &payload) != nil {
			return false
		}
		gotCanvas, _ := payload["canvasId"].(string)
		revision, ok := jsonWholeNumber(payload["revision"])
		if gotCanvas != canvasID || !ok || revision <= before || revision > after || covered[revision] {
			return false
		}
		covered[revision] = true
	}
	for revision := before + 1; revision <= after; revision++ {
		if !covered[revision] {
			return false
		}
	}
	return true
}

func jsonWholeNumber(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int64(typed)) {
			return 0, false
		}
		return int64(typed), true
	case int64:
		return typed, true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

// assistantTurnMatchesChange 核对单次写入的文档差异是否和变更摘要一致。
// 它只能证明范围，不能证明多次写入里谁改了同一个节点。
func assistantTurnMatchesChange(before, after map[string]any, change *AssistantTurnChange) bool {
	if change == nil {
		return false
	}
	remaining := make(map[string]any, len(after))
	for key, value := range after {
		remaining[key] = value
	}
	for _, field := range []struct {
		name             string
		created, updated []string
	}{
		{"nodes", change.CreatedNodeIDs, change.UpdatedNodeIDs},
		{"connections", change.CreatedEdgeIDs, nil},
	} {
		oldItems, oldOK := before[field.name].([]any)
		newItems, newOK := after[field.name].([]any)
		if !oldOK || !newOK {
			return false
		}
		oldByID := make(map[string]any, len(oldItems))
		for _, item := range oldItems {
			obj, ok := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !ok || id == "" || oldByID[id] != nil {
				return false
			}
			oldByID[id] = item
		}
		declared := make(map[string]bool)
		for _, id := range field.created {
			if declared[id] || id == "" || oldByID[id] != nil {
				return false
			}
			declared[id] = true
		}
		for _, id := range field.updated {
			if _, exists := declared[id]; exists || oldByID[id] == nil {
				return false
			}
			declared[id] = false
		}
		projected := make([]any, 0, len(newItems))
		seen := make(map[string]bool)
		for _, item := range newItems {
			obj, ok := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !ok || id == "" || seen[id] {
				return false
			}
			seen[id] = true
			if created, exists := declared[id]; exists {
				delete(declared, id)
				if created {
					continue
				}
				item = oldByID[id]
			}
			projected = append(projected, item)
		}
		if len(declared) != 0 || !reflect.DeepEqual(oldItems, projected) {
			return false
		}
		remaining[field.name] = before[field.name]
	}
	for _, key := range []string{"revision", "updatedAt", "remoteContentHash"} {
		if value, exists := before[key]; exists {
			remaining[key] = value
		} else {
			delete(remaining, key)
		}
	}
	return reflect.DeepEqual(before, remaining)
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
