package model

import "time"

const (
	MandateStatusActive    = "active"
	MandateStatusExhausted = "exhausted"
	MandateStatusRevoked   = "revoked"
	MandateStatusExpired   = "expired"

	MandateReservationStatusReserved = "reserved"
	MandateReservationStatusSpent    = "spent"
	MandateReservationStatusReleased = "released"

	MandateKindImage           = "image"
	MandateKindVideo           = "video"
	MandateKindAudio           = "audio"
	MandateKindMediaReview     = "media_review"
	MandateKindMediaTranscribe = "media_transcribe"
)

// AssistantProductionMandate is an owner-approved bounded spend budget pack for
// a canvas (and optional durable session). Built-in assistant paid tools reserve
// against this ledger atomically inside SQLite transactions so multi-shot
// productions run without per-call approval fatigue while enforcing hard CNY and
// unquoted-slot ceilings.
type AssistantProductionMandate struct {
	ID                string     `json:"id" gorm:"column:id;primaryKey;size:64"`
	UserID            string     `json:"userId" gorm:"column:user_id;size:64;not null;index:idx_assistant_mandates_user_canvas,priority:1"`
	CanvasID          string     `json:"canvasId" gorm:"column:canvas_id;size:80;not null;index:idx_assistant_mandates_user_canvas,priority:2"`
	SessionID         string     `json:"sessionId" gorm:"column:session_id;size:128;not null;default:'';index:idx_assistant_mandates_user_canvas,priority:3"`
	MaxAmountCNY      float64    `json:"maxAmountCny" gorm:"column:max_amount_cny;not null;default:0"`
	SpentAmountCNY    float64    `json:"spentAmountCny" gorm:"column:spent_amount_cny;not null;default:0"`
	ReservedAmountCNY float64    `json:"reservedAmountCny" gorm:"column:reserved_amount_cny;not null;default:0"`
	MaxUnquotedCount  int        `json:"maxUnquotedCount" gorm:"column:max_unquoted_count;not null;default:0"`
	UsedUnquotedCount int        `json:"usedUnquotedCount" gorm:"column:used_unquoted_count;not null;default:0"`
	AllowedKindsJSON  string     `json:"-" gorm:"column:allowed_kinds_json;type:text;not null;default:'[]'"`
	Status            string     `json:"status" gorm:"column:status;size:24;not null;default:'active';index"`
	Version           int64      `json:"version" gorm:"column:version;not null;default:1"`
	ApprovedBy        string     `json:"approvedBy" gorm:"column:approved_by;size:64;not null;default:''"`
	ExpiresAt         *time.Time `json:"expiresAt,omitempty" gorm:"column:expires_at"`
	CreatedAt         time.Time  `json:"createdAt" gorm:"column:created_at"`
	UpdatedAt         time.Time  `json:"updatedAt" gorm:"column:updated_at"`
}

func (AssistantProductionMandate) TableName() string { return "assistant_production_mandates" }

// AssistantMandateReservation tracks one explicit spend or unquoted-slot
// reservation linked to a paid tool invocation (and its created task when async).
// The unique index on (mandate_id, call_id) guarantees idempotency across retries.
type AssistantMandateReservation struct {
	ID        string    `json:"id" gorm:"column:id;primaryKey;size:64"`
	MandateID string    `json:"mandateId" gorm:"column:mandate_id;size:64;not null;uniqueIndex:idx_assistant_mandate_res_call,priority:1;index"`
	UserID    string    `json:"userId" gorm:"column:user_id;size:64;not null;index"`
	TaskID    string    `json:"taskId" gorm:"column:task_id;size:64;not null;default:'';index"`
	CallID    string    `json:"callId" gorm:"column:call_id;size:160;not null;uniqueIndex:idx_assistant_mandate_res_call,priority:2"`
	Kind      string    `json:"kind" gorm:"column:kind;size:32;not null"`
	AmountCNY float64   `json:"amountCny" gorm:"column:amount_cny;not null;default:0"`
	Unquoted  bool      `json:"unquoted" gorm:"column:unquoted;not null;default:false"`
	Status    string    `json:"status" gorm:"column:status;size:24;not null;default:'reserved';index"`
	CreatedAt time.Time `json:"createdAt" gorm:"column:created_at"`
	UpdatedAt time.Time `json:"updatedAt" gorm:"column:updated_at"`
}

func (AssistantMandateReservation) TableName() string { return "assistant_mandate_reservations" }
