package model

import "time"

const (
	TaskEffectKindDeliverySettled = "delivery_settled"
	TaskEffectKindTaskBindSettled = "task_bind_settled"
	TaskEffectKindCanvasBind      = "canvas_bind"
	TaskEffectKindMessageAttach   = "message_attach"
	TaskEffectKindCanvasMissing   = "canvas_missing"

	TaskEffectStatusPending = "pending"
	TaskEffectStatusRefused = "refused"
	TaskEffectStatusSettled = "settled"

	// Canonical generation delivery stages shared across migrations, recovery
	// queries, and delivery controllers.
	TaskStageFetchingResult   = "正在取回结果"
	TaskStageDeliveryPaused   = "delivery_paused"
	TaskStageDeliveryTimedOut = "delivery_timed_out"
)

// RevisionWatchCanvasBindReasons are terminal canvas bind refusals that can
// become eligible again once the target canvas's revision advances.
// Shared as the single source of truth between Go refusal evaluation and SQL
// pending-task queries.
var RevisionWatchCanvasBindReasons = []string{
	"node_deleted",
	"node_task_mismatch",
}

// PermanentCanvasBindReasons are terminal canvas bind refusals determined
// solely by the task itself (canvas edits cannot resolve them).
var PermanentCanvasBindReasons = []string{
	"node_mismatch",
	"canvas_mismatch",
}

func IsRevisionWatchCanvasBindReason(reason string) bool {
	for _, candidate := range RevisionWatchCanvasBindReasons {
		if reason == candidate {
			return true
		}
	}
	return false
}

func IsPermanentCanvasBindReason(reason string) bool {
	for _, candidate := range PermanentCanvasBindReasons {
		if reason == candidate {
			return true
		}
	}
	return false
}

// TaskEffect persists post-completion side-effect progress (delivery, canvas
// node binding, conversation attachment) outside tasks.recovery_outcome so
// background recovery never re-scans settled historical tasks or collides with
// media recovery conclusions.
type TaskEffect struct {
	ID              string    `gorm:"primaryKey;size:64"`
	UserID          string    `gorm:"size:64;not null;index"`
	TaskID          string    `gorm:"size:64;not null;uniqueIndex:idx_task_effects_identity,priority:1;index:idx_task_effects_task_kind_status,priority:1"`
	Kind            string    `gorm:"size:32;not null;uniqueIndex:idx_task_effects_identity,priority:2;index:idx_task_effects_task_kind_status,priority:2"`
	CanvasID        string    `gorm:"size:64;not null;default:''"`
	NodeID          string    `gorm:"size:128;not null;default:'';uniqueIndex:idx_task_effects_identity,priority:3"`
	OutputIndex     int       `gorm:"not null;default:0;uniqueIndex:idx_task_effects_identity,priority:4"`
	ConversationID  string    `gorm:"size:64;not null;default:'';uniqueIndex:idx_task_effects_identity,priority:5"`
	MessageID       string    `gorm:"size:64;not null;default:'';uniqueIndex:idx_task_effects_identity,priority:6"`
	Status          string    `gorm:"size:24;not null;default:'pending';index:idx_task_effects_task_kind_status,priority:3"`
	Reason          string    `gorm:"size:64;not null;default:''"`
	RefusedRevision int64     `gorm:"not null;default:0"`
	Attempts        int       `gorm:"not null;default:0"`
	NextAttemptAt   time.Time `gorm:"not null"`
	LastError       string    `gorm:"type:text"`
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

func (TaskEffect) TableName() string { return "task_effects" }
