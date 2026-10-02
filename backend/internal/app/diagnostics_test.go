package app

import (
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestExportDiagnosticBundleAdapterRejectsForeignTask(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diagnostics-adapter-ownership?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "foreign-task", UserID: "user-2", CreatedAt: time.Now(), UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = (&Service{repo: repository.New(db)}).ExportDiagnosticBundle("user-1", DiagnosticExportRequest{TaskID: "foreign-task"})
	if err == nil || !strings.Contains(err.Error(), "任务不存在或无权访问") {
		t.Fatalf("foreign task error = %v", err)
	}
}
