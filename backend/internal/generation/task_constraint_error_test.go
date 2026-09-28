package generation

import "testing"

func TestNestedTaskTypeConstraint(t *testing.T) {
	raw := `{"error":{"code":"upstream_error","message":"{\"code\":\"fail_to_fetch_task\",\"message\":\"InvalidParameter.TaskTypeConstraint: The parameter ratio specified in the request is not valid. For first-frame or first-last-frame generation, the output ratio follows the first-frame image\"}"}}`
	got := ClassifyText(raw)
	got.RequestID = "req_task_constraint_123"
	if got.Category != CategoryInvalidParams || got.Reason != "首尾帧模式的画面比例需跟随首帧" {
		t.Fatalf("unexpected classification: %#v", got)
	}
	readback := ClassifyText(got.UserMessage())
	if readback.Category != got.Category || readback.Reason != got.Reason || readback.RequestID != got.RequestID {
		t.Fatalf("persisted copy lost: %#v", readback)
	}
}
