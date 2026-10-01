package creation

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

const leaseTTL = 45 * time.Second

var reservedConfirmOwners = map[string]struct{}{
	"model": {}, "assistant": {}, "agent": {}, "system": {},
	"pi": {}, "cloud_agent": {}, "cloud-agent": {},
}

func validateGuard(run *model.CreationRun, guard Guard, now time.Time) error {
	if guard.Owner == "" || run.ExecutionOwner != guard.Owner || run.ExecutionEpoch != guard.ExecutionEpoch || run.LeaseExpiresAt == nil || !run.LeaseExpiresAt.After(now) {
		return Conflict(msgLeaseExpired)
	}
	return nil
}

func validateConfirmOwner(owner string) error {
	key := strings.ToLower(strings.TrimSpace(owner))
	if key == "" {
		return Conflict(msgModelSelfConfirm)
	}
	if _, reserved := reservedConfirmOwners[key]; reserved {
		return Conflict(msgModelSelfConfirm)
	}
	if strings.HasPrefix(key, "model:") || strings.HasPrefix(key, "assistant:") || strings.HasPrefix(key, "agent:") {
		return Conflict(msgModelSelfConfirm)
	}
	return nil
}

func validRunStatus(status string) bool {
	switch status {
	case "idle", "running", "waiting_answer", "waiting_proposal", "waiting_canvas", "waiting_execution", "waiting_task", "paused", "completed", "cancelled":
		return true
	default:
		return false
	}
}
