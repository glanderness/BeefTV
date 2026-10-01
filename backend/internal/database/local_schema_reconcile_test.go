package database

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func fixtureHasDiagnostics(history string) bool {
	return strings.HasPrefix(history, "product") && history != "product-v1" && history != "product-v2" && history != "product-v3-missing"
}

// Synthetic branch-shape fixtures, not copies of customer databases. Agent v4
// and v5 column contracts follow commits 2525b2c and 05edc16 respectively.
func reconciliationFixture(t *testing.T, history string) *gorm.DB {
	t.Helper()
	db, err := Open(Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "fixture.db")})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := db.DB()
	t.Cleanup(func() { _ = connection.Close() })
	if err := db.AutoMigrate(&localSchemaMigration{}); err != nil {
		t.Fatal(err)
	}
	if err := migrateLocalCoreSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE tasks DROP COLUMN failure_diagnostics").Error; err != nil {
		t.Fatal(err)
	}
	exec := func(sql string) {
		t.Helper()
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	names := map[int64]string{1: "local-core-schema", 2: "retire-hosted-schema"}
	if strings.HasPrefix(history, "agent") {
		names[3] = "agent-operation-records"
		if history == "agent-v4" || history == "agent-v5" {
			names[4] = "task-client-operation"
		}
		if history == "agent-v5" {
			names[5] = "task-client-operation-hash"
		}
		if history == "agent-v6" {
			names[4], names[5], names[6] = "task-client-operation", "task-client-operation-hash", "agent-operation-turn-attribution"
		} else {
			exec("DROP INDEX idx_agent_op_records_turn_id")
			exec("ALTER TABLE agent_op_records DROP COLUMN turn_id")
		}
	} else {
		exec("DROP TABLE agent_op_records")
		names[3] = "task-failure-diagnostics"
		if history == "image-v3" {
			names[3] = "image-submission-recovery"
		}
		if strings.HasPrefix(history, "product-v7") {
			names[7] = "product-image-recovery-and-diagnostics"
		}
	}
	if history != "agent-v4" && history != "agent-v5" && history != "agent-v6" {
		exec("DROP INDEX idx_tasks_user_client_op")
		exec("ALTER TABLE tasks DROP COLUMN client_operation_id")
	}
	if history != "agent-v5" && history != "agent-v6" {
		exec("ALTER TABLE tasks DROP COLUMN client_operation_hash")
	}
	if fixtureHasDiagnostics(history) {
		exec("ALTER TABLE tasks ADD COLUMN failure_diagnostics TEXT")
	}
	if history != "product-v7" && history != "image-v3" {
		exec("DROP TABLE image_submissions")
	}
	if history == "product-v7-missing" {
		names[7] = "unrelated-branch-v7"
	}
	if history == "product-v1" {
		delete(names, 2)
		delete(names, 3)
	}
	if history == "product-v2" {
		delete(names, 3)
	}
	for version, name := range names {
		if err := db.Create(&localSchemaMigration{Version: version, Name: name, AppliedAt: time.Now()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO tasks(id,user_id,type,status,input_json,result_json,error) VALUES ('task','owner','canvas_image','failed','{"source":"original"}','{"resourceId":"resource"}','historical error')`)
	if fixtureHasDiagnostics(history) {
		exec(`UPDATE tasks SET failure_diagnostics = '{"source":"gateway","requestId":"request"}'`)
	}
	if history == "agent-v6" {
		exec(`UPDATE tasks SET client_operation_id = 'operation', client_operation_hash = 'hash'`)
		exec(`INSERT INTO agent_op_records(user_id,op_id,status,result_json,turn_id) VALUES ('owner','operation','completed','{"taskId":"task"}','turn')`)
	} else if strings.HasPrefix(history, "agent") {
		exec(`INSERT INTO agent_op_records(user_id,op_id,status,result_json) VALUES ('owner','operation','completed','{"taskId":"task"}')`)
	}
	if db.Migrator().HasTable(&model.ImageSubmission{}) {
		if err := db.Create(&model.ImageSubmission{AttemptID: "attempt", TaskID: "task", UserID: "owner", RequestCipher: "opaque-fixture", SendCount: 4, ResponseAccepted: true, CreatedAt: time.Now()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&model.Resource{ID: "resource", UserID: "owner", ObjectKey: "fixture-output.png"}).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func TestAgentProductReconcileHistoricalLedgers(t *testing.T) {
	for _, history := range []string{"product-v1", "product-v2", "product-v3", "product-v3-missing", "product-v7", "product-v7-missing", "agent-v3", "agent-v4", "agent-v5", "agent-v6", "image-v3"} {
		t.Run(history, func(t *testing.T) {
			db := reconciliationFixture(t, history)
			var before []localSchemaMigration
			if err := db.Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err := MigrateLocalSchema(db); err != nil {
					t.Fatal(err)
				}
				if err := RequireLocalSchema(db); err != nil {
					t.Fatal(err)
				}
			}
			var task model.Task
			if err := db.First(&task, "id = ?", "task").Error; err != nil {
				t.Fatal(err)
			}
			if task.Error != "historical error" || task.Status != model.TaskStatusFailed || task.InputJSON != `{"source":"original"}` || task.ResultJSON != `{"resourceId":"resource"}` {
				t.Fatalf("task changed: %+v", task)
			}
			var diagnostic string
			if fixtureHasDiagnostics(history) {
				if err := db.Raw("SELECT failure_diagnostics FROM tasks WHERE id = 'task'").Scan(&diagnostic).Error; err != nil {
					t.Fatal(err)
				}
				if diagnostic != `{"source":"gateway","requestId":"request"}` {
					t.Fatalf("diagnostic changed: %s", diagnostic)
				}
			}
			for _, old := range before {
				var actual localSchemaMigration
				if err := db.First(&actual, "version = ?", old.Version).Error; err != nil {
					t.Fatal(err)
				}
				if actual.Name != old.Name || !actual.AppliedAt.Equal(old.AppliedAt) {
					t.Fatalf("ledger rewritten: %+v", actual)
				}
			}
			if strings.HasPrefix(history, "agent") {
				var receipt model.AgentOpRecord
				if err := db.First(&receipt, "op_id = ?", "operation").Error; err != nil {
					t.Fatal(err)
				}
				if receipt.ResultJSON != `{"taskId":"task"}` || (history == "agent-v6" && (receipt.TurnID != "turn" || task.ClientOperationID == nil || *task.ClientOperationID != "operation" || task.ClientOperationHash != "hash")) {
					t.Fatalf("agent data changed: %+v %+v", receipt, task)
				}
			}
			if history == "product-v7" || history == "image-v3" {
				var row model.ImageSubmission
				if err := db.First(&row, "attempt_id = ?", "attempt").Error; err != nil {
					t.Fatal(err)
				}
				if row.SendCount != 4 || !row.ResponseAccepted || row.RequestCipher != "opaque-fixture" {
					t.Fatalf("image identity changed: %+v", row)
				}
			}
			var resource model.Resource
			if err := db.First(&resource, "id = ?", "resource").Error; err != nil || resource.ObjectKey != "fixture-output.png" {
				t.Fatalf("resource changed: %+v %v", resource, err)
			}
			if err := db.Exec("UPDATE tasks SET client_operation_id='unique' WHERE id='task'").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('duplicate','owner','unique')").Error; err == nil {
				t.Fatal("idempotency unique index not enforced")
			}
		})
	}
}

func TestAgentProductReconcileLedgerWriteFailureRollsBackDDL(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	if err := db.Exec("CREATE TRIGGER fail_v8 BEFORE INSERT ON local_schema_migrations WHEN NEW.version=8 BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err == nil || !strings.Contains(err.Error(), "injected ledger failure") {
		t.Fatalf("failure not injected: %v", err)
	}
	version, _ := currentSchemaVersion(db)
	if version != 7 || db.Migrator().HasTable(&model.AgentOpRecord{}) || db.Migrator().HasColumn(&model.Task{}, "ClientOperationID") {
		t.Fatal("failed v8 left partial schema or ledger")
	}
	if err := db.Exec("DROP TRIGGER fail_v8").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
}

func TestAgentProductReconcileDuplicateIdentityFailsWithoutDataLoss(t *testing.T) {
	db := reconciliationFixture(t, "agent-v6")
	if err := db.Exec("DROP INDEX idx_tasks_user_client_op").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('duplicate','owner','operation')").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err == nil {
		t.Fatal("duplicate identities silently reconciled")
	}
	version, _ := currentSchemaVersion(db)
	if version != 6 || db.Migrator().HasTable(&model.ImageSubmission{}) || db.Migrator().HasColumn("tasks", "failure_diagnostics") {
		t.Fatal("failed index creation left partial v8")
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("rows lost: %d %v", count, err)
	}
}

func TestAgentProductReconcileBackupRestoreUsesOldSchemaCopy(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	backup := filepath.Join(t.TempDir(), "before-v8.db")
	if err := db.Exec("VACUUM INTO ?", backup).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(Config{Driver: "sqlite", DSN: backup})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := restored.DB()
	defer connection.Close()
	version, err := currentSchemaVersion(restored)
	if err != nil || version != 7 || restored.Migrator().HasTable(&model.AgentOpRecord{}) {
		t.Fatalf("backup changed: %d %v", version, err)
	}
	var result string
	if err := restored.Raw("SELECT result_json FROM tasks WHERE id='task'").Scan(&result).Error; err != nil || result != `{"resourceId":"resource"}` {
		t.Fatalf("restore result: %s %v", result, err)
	}
	if err := RequireLocalSchema(restored); err == nil {
		t.Fatal("new binary accepted old schema without migration")
	}
}

func TestAgentProductReconcileSameVersionDamageIsNotReady(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v8 ledger hid missing structure")
	}
	if err := MigrateLocalSchema(db); err == nil {
		t.Fatal("v8 damage silently accepted by migrator")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || status.Ready {
		t.Fatalf("ready after damage: %+v %v", status, err)
	}
}

func TestAgentProductReconcileRefusesFutureVersion(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	if err := db.Create(&localSchemaMigration{Version: CurrentSchemaVersion + 1, Name: "future", AppliedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err == nil {
		t.Fatal("future schema accepted")
	}
	if db.Migrator().HasTable(&model.AgentOpRecord{}) {
		t.Fatal("future schema modified")
	}
}
