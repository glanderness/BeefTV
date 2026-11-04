package app

import (
	"context"
	"testing"

	"infinite-canvas/backend/internal/generation"
)

func TestWorkflowReceiptUpdatesDisplayStageThroughLeasePort(t *testing.T) {
	s, task := workflowPaidTaskFixture(t)
	ctx := withProviderAnalytics(context.Background(), s, task)
	ctx = generation.WithRuntime(ctx, generation.Runtime{Stages: appTaskStagePort{service: s, task: task}})
	receipt := workflowReceipt{service: s}
	if err := receipt.RecordAccepted(ctx, "rh-task", "submitted", nil); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ provider, display string }{
		{"submitted", "上游已受理，等待生成"},
		{"queued", "上游排队中"},
		{"running", "正在生成"},
		{"downloading", "正在下载生成结果"},
		{"succeeded", "正在保存生成结果"},
	} {
		if err := receipt.UpdateStage(ctx, "rh-task", tc.provider, nil); err != nil {
			t.Fatal(err)
		}
		got, err := s.repo.Task(task.ID)
		if err != nil || got.Stage != tc.display || got.PollStage != tc.provider || got.Status != task.Status || got.Progress != task.Progress {
			t.Fatalf("stage %s: got=%+v err=%v", tc.provider, got, err)
		}
	}
	stale := task
	stale.LeaseOwner = "old-owner"
	ctx = generation.WithRuntime(ctx, generation.Runtime{Stages: appTaskStagePort{service: s, task: stale}})
	if err := receipt.UpdateStage(ctx, "rh-task", "running", nil); err != nil {
		t.Fatalf("display update must not fail the accepted task: %v", err)
	}
	got, err := s.repo.Task(task.ID)
	if err != nil || got.Stage != "正在保存生成结果" || got.Status != task.Status {
		t.Fatalf("stale worker overwrote display stage: %+v err=%v", got, err)
	}
}
