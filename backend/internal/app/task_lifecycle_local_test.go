package app

import (
	"testing"

	localtask "infinite-canvas/backend/internal/task"
)

func TestTaskCancellationPendingRetryMessageIsLocal(t *testing.T) {
	if got := localtask.CancellationPendingRetryMessage; got != "上一次取消请求仍在确认中，请稍后重试" {
		t.Fatalf("local retry message = %q", got)
	}
}
