package repository

import (
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestMCPTaskBillUsesSettledAttemptsInOriginalRun(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.MCPCall{}, &model.Task{}, &model.RouteAttempt{}, &model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	task := model.Task{ID: "task", UserID: "owner", Model: "model-a", RouteRun: 1, Status: model.TaskStatusSucceeded}
	insert := func(row any) {
		t.Helper()
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	insert(&task)
	insert(&model.RouteAttempt{ID: "first", TaskID: task.ID, RouteRun: 1})
	insert(&model.ImageSubmission{AttemptID: "first", TaskID: task.ID, UserID: task.UserID})
	call := model.MCPCall{UserID: task.UserID, Tool: "canvas.generation.submit", QuotaPerYuan: 1000, Billing: "unknown"}
	if err = repo.RecordMCPCall(&call, []string{task.ID}); err != nil {
		t.Fatal(err)
	}
	read := func() model.MCPCall {
		t.Helper()
		rows, err := repo.RecentMCPCalls(task.UserID)
		if err != nil || len(rows) != 1 {
			t.Fatalf("read %d rows: %v", len(rows), err)
		}
		return rows[0]
	}
	if got := read(); got.ModelName != "model-a" || got.AmountCNY != nil {
		t.Fatalf("unsettled %+v", got)
	}
	for _, quota := range []int64{250, 0} {
		if err := repo.RecordMediaSettlement("first", task, quota); err != nil {
			t.Fatal(err)
		}
		got := read()
		if got.AmountCNY == nil || *got.AmountCNY != float64(quota)/1000 {
			t.Fatalf("settled %+v", got)
		}
	}
	if err = db.Model(&task).Update("route_run", 2).Error; err != nil {
		t.Fatal(err)
	}
	insert(&model.RouteAttempt{ID: "retry", TaskID: task.ID, RouteRun: 2})
	amount := int64(900)
	insert(&model.ImageSubmission{AttemptID: "retry", TaskID: task.ID, UserID: task.UserID, SettledQuota: &amount})
	if got := read(); got.AmountCNY == nil || *got.AmountCNY != 0 {
		t.Fatalf("retry changed original bill %+v", got)
	}
	if rows, err := repo.RecentMCPCalls("another"); err != nil || len(rows) != 0 {
		t.Fatalf("foreign history: %v %v", rows, err)
	}
}

func TestRecentMCPCallsRetainsNewestPerWorkspace(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.MCPCall{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	base := time.Now().UTC()
	record := func(user string, at time.Time) *model.MCPCall {
		t.Helper()
		row := &model.MCPCall{UserID: user, CreatedAt: at, Tool: "agent.guide", Billing: "none"}
		if err := repo.RecordMCPCall(row, nil); err != nil {
			t.Fatal(err)
		}
		return row
	}
	other := record("other", base)
	// Long-running tools can finish after newer invocations.
	for i := retainedMCPCalls; i >= 0; i-- {
		record("owner", base.Add(time.Duration(i)*time.Second))
	}
	var count int64
	if err = db.Model(&model.MCPCall{}).Where("user_id = ?", "owner").Count(&count).Error; err != nil || count != retainedMCPCalls {
		t.Fatalf("retention: %d, %v", count, err)
	}
	rows, err := repo.RecentMCPCalls("owner")
	if err != nil || len(rows) != 10 {
		t.Fatalf("limit: %d, %v", len(rows), err)
	}
	for i, row := range rows {
		if !row.CreatedAt.Equal(base.Add(time.Duration(retainedMCPCalls-i) * time.Second)) {
			t.Fatalf("out-of-order row %d %v", i, row.CreatedAt)
		}
	}
	rows, err = repo.RecentMCPCalls("other")
	if err != nil || len(rows) != 1 || rows[0].ID != other.ID {
		t.Fatalf("other workspace: %+v, %v", rows, err)
	}
}

func TestRecordMCPCallMarksLocalMediaTransformAsFree(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.MCPCall{}, &model.Task{}, &model.RouteAttempt{}, &model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	localTask := model.Task{ID: "local-1", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Provider: "local", Status: model.TaskStatusSucceeded}
	if err = db.Create(&localTask).Error; err != nil {
		t.Fatal(err)
	}
	call := model.MCPCall{UserID: "owner", Tool: "business_post_tasks", Billing: "unknown"}
	if err = repo.RecordMCPCall(&call, []string{localTask.ID}); err != nil {
		t.Fatal(err)
	}
	rows, err := repo.RecentMCPCalls("owner")
	if err != nil || len(rows) != 1 || rows[0].Billing != "none" || rows[0].AmountCNY != nil {
		t.Fatalf("local task should have Billing=none: %+v, %v", rows, err)
	}
}
