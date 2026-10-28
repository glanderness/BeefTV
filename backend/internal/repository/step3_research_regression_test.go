package repository

// 研究夹具：同库关闭重开与并发接纳；不启动生成 worker。
import (
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
)

func TestStep3PaidAdmissionConcurrentAndReopen(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	db.Logger = logger.Default.LogMode(logger.Silent)
	task := model.Task{ID: "paid-admission", UserID: "user", Type: "canvas_text", Status: model.TaskStatusFailed, RouteRun: 3, InputJSON: `{}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := repo.RetryTaskWithOperation("user", &task, 8, "same-operation", "same-payload")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("并发请求失败：%v", err)
		}
	}
	var current model.Task
	if err := db.First(&current, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if current.RouteRun != 4 {
		t.Fatalf("并发重复接纳：routeRun=%d", current.RouteRun)
	}
	// 新一轮再次失败后，关闭数据库连接并重新打开同一个临时 SQLite。
	if err := db.Model(&current).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	dsn := db.Dialector.(*sqlite.Dialector).DSN
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { pool, _ := reopened.DB(); _ = pool.Close() }()
	replayed, err := New(reopened).RetryTaskWithOperation("user", &task, 8, "same-operation", "same-payload")
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.First(&current, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	var receipts int64
	if err := reopened.Model(&model.AgentOpRecord{}).Count(&receipts).Error; err != nil {
		t.Fatal(err)
	}
	t.Run("single_admission_after_reopen", func(t *testing.T) {
		if current.RouteRun != 4 || current.Status != model.TaskStatusFailed || receipts != 1 {
			t.Fatalf("重放改变新轮次：run=%d status=%s receipts=%d", current.RouteRun, current.Status, receipts)
		}
	})
	t.Run("receipt_preserves_run", func(t *testing.T) {
		if replayed.RouteRun != 4 {
			t.Fatalf("回执丢失生成轮次：storedRun=%d replayedRun=%d", current.RouteRun, replayed.RouteRun)
		}
	})
}
