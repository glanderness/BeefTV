package assistantturns

import (
	"encoding/json"
	"strings"
	"time"
)

const (
	ReasonNotFound      = "turn_not_found"
	ReasonNoChange      = "turn_has_no_change"
	ReasonAlreadyUndone = "turn_already_undone"
	ReasonCanvasChanged = "canvas_changed_since_turn"
	ReasonIDCollision   = "turn_id_conflict"
	ReasonCorruptFile   = "turn_file_corrupt"
	ReasonOwnership     = "turn_file_ownership"
	ReasonNotOpen       = "turn_not_open"
	ReasonIdentity      = "turn_identity_required"
	ReasonStore         = "turn_store_unavailable"
)

const (
	StateOpen    = "open"
	StateSettled = "settled"
)

const retainSettled = 64

// Error carries a stable reason so HTTP handlers can project 409/404.
type Error struct {
	Reason  string
	Message string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Reason
}

func errNotFound() *Error {
	return &Error{Reason: ReasonNotFound, Message: "轮次不存在"}
}

func errInvalidID() *Error {
	return &Error{Reason: ReasonNotFound, Message: "轮次标识无效"}
}

func errCorruptStored() *Error {
	return &Error{Reason: ReasonCorruptFile, Message: "轮次记录损坏，已保留现场"}
}

// Change is the canvas effect of one business round, reconstructed from
// operation receipts that share this turn identity.
type Change struct {
	RevisionBefore int64    `json:"revisionBefore"`
	RevisionAfter  int64    `json:"revisionAfter"`
	CreatedNodeIDs []string `json:"createdNodeIds"`
	UpdatedNodeIDs []string `json:"updatedNodeIds"`
	CreatedEdgeIDs []string `json:"createdEdgeIds"`
	OperationIDs   []string `json:"operationIds,omitempty"`
}

// Input is the backend-verified explicit context at Begin. The model cannot
// grant extra references.
type Input struct {
	SelectedNodeIDs []string
	AssetIDs        []string
	CanvasIDs       []string
}

// Scope is the backend-verified read/write range for an open round.
type Scope struct {
	CanvasID  string
	AssetIDs  []string
	CanvasIDs []string
	TaskIDs   []string
}

// HistoryState supplements pi conversation history with business receipts.
// Reading it never settles or cancels an active round.
type HistoryState struct {
	Change *Change
	Undone bool
}

// Record is the in-memory business round. Document is the pre-turn canvas
// snapshot, not a chat transcript.
type Record struct {
	TurnID              string
	UserID              string
	CanvasID            string
	RevisionBefore      int64
	CreatedAt           time.Time
	State               string
	SelectedNodeIDs     []string
	ReferencedAssetIDs  []string
	ReferencedCanvasIDs []string
	AssociatedAssetIDs  []string
	AssociatedTaskIDs   []string
	Undone              bool
	Change              *Change
	Document            json.RawMessage
}

func (r Record) effectiveState() string {
	if strings.TrimSpace(r.State) == "" {
		return StateSettled
	}
	return r.State
}

func (r Record) sameBeginScope(userID, canvasID string, input Input) bool {
	return r.UserID == userID && r.CanvasID == canvasID &&
		equalStringLists(r.SelectedNodeIDs, uniqueSorted(input.SelectedNodeIDs)) &&
		equalStringLists(r.ReferencedAssetIDs, uniqueSorted(input.AssetIDs)) &&
		equalStringLists(r.ReferencedCanvasIDs, uniqueSorted(input.CanvasIDs))
}

func equalStringLists(a, b []string) bool {
	left := uniqueSorted(a)
	right := uniqueSorted(b)
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
