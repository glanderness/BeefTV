package database

import (
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

// The branch-specific ledger names and extension columns match Agent 2d1ce6b.
// Keep this fixture independent of Agent runtime models: product migration must
// preserve unknown extensions without importing the experimental runtime.
func TestProductRecoveryMigrationPreservesHistoricalSchemas(t *testing.T) {
	for _, history := range []string{"product-v3", "agent-v6", "image-v3"} {
		t.Run(history, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "workspace.db")
			db, err := Open(Config{Driver: "sqlite", DSN: path})
			if err != nil {
				t.Fatal(err)
			}
			if err := db.AutoMigrate(&localSchemaMigration{}); err != nil {
				t.Fatal(err)
			}
			if err := migrateLocalCoreSchema(db); err != nil {
				t.Fatal(err)
			}
			if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
				t.Fatal(err)
			}
			names := []string{"local-core-schema", "retire-hosted-schema", "task-failure-diagnostics"}
			if history != "product-v3" {
				if err := db.Migrator().DropColumn(&model.Task{}, "FailureDiagnostics"); err != nil {
					t.Fatal(err)
				}
			}
			if history == "image-v3" {
				names[2] = "image-submission-recovery"
				if err := db.AutoMigrate(&model.ImageSubmission{}); err != nil {
					t.Fatal(err)
				}
				if err := db.Create(&model.ImageSubmission{AttemptID: "attempt", TaskID: "task", UserID: "owner", RequestCipher: "opaque-fixture", SendCount: 5, CreatedAt: time.Now()}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if history == "agent-v6" {
				names = []string{"local-core-schema", "retire-hosted-schema", "agent-operation-records", "task-client-operation", "task-client-operation-hash", "agent-operation-turn-attribution"}
				for _, sql := range []string{
					"ALTER TABLE tasks ADD COLUMN client_operation_id TEXT",
					"ALTER TABLE tasks ADD COLUMN client_operation_hash TEXT",
					"CREATE UNIQUE INDEX idx_tasks_user_client_op ON tasks(user_id, client_operation_id)",
					"CREATE TABLE agent_op_records (user_id TEXT, op_id TEXT, op TEXT, payload_hash TEXT, status TEXT, result_json TEXT, turn_id TEXT, created_at DATETIME, updated_at DATETIME, PRIMARY KEY(user_id, op_id))",
					"CREATE INDEX idx_agent_op_records_turn_id ON agent_op_records(turn_id)",
					"INSERT INTO agent_op_records(user_id, op_id, status, result_json, turn_id) VALUES ('owner', 'operation', 'completed', '{\"taskId\":\"task\"}', 'turn')",
				} {
					if err := db.Exec(sql).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
			for i, name := range names {
				if err := db.Create(&localSchemaMigration{Version: int64(i + 1), Name: name, AppliedAt: time.Now()}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Exec("INSERT INTO tasks(id, user_id, type, status, input_json, error) VALUES ('task', 'owner', 'canvas_image', 'failed', '{\"original\":true}', 'historical failure')").Error; err != nil {
				t.Fatal(err)
			}
			if history == "agent-v6" {
				if err := db.Exec("UPDATE tasks SET client_operation_id = 'operation', client_operation_hash = 'payload-hash' WHERE id = 'task'").Error; err != nil {
					t.Fatal(err)
				}
			}
			connection, _ := db.DB()
			if err := connection.Close(); err != nil {
				t.Fatal(err)
			}
			db, err = Open(Config{Driver: "sqlite", DSN: path})
			if err != nil {
				t.Fatal(err)
			}
			connection, _ = db.DB()
			defer connection.Close()
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
			if task.InputJSON != `{"original":true}` || task.Error != "historical failure" || task.Status != model.TaskStatusFailed || task.FailureDiagnostics != nil {
				t.Fatalf("task changed: %+v", task)
			}
			if !db.Migrator().HasTable(&model.ImageSubmission{}) {
				t.Fatal("missing recovery table")
			}
			var ledger []localSchemaMigration
			if err := db.Order("version").Find(&ledger).Error; err != nil {
				t.Fatal(err)
			}
			if len(ledger) != len(names)+1 || ledger[len(names)].Version != 7 {
				t.Fatalf("ledger: %+v", ledger)
			}
			for i, name := range names {
				if ledger[i].Name != name {
					t.Fatalf("historical ledger overwritten: %+v", ledger)
				}
			}
			if history == "agent-v6" {
				var extension struct{ ClientOperationID, ClientOperationHash string }
				if err := db.Table("tasks").Select("client_operation_id, client_operation_hash").Where("id = ?", "task").Scan(&extension).Error; err != nil {
					t.Fatal(err)
				}
				if extension.ClientOperationID != "operation" || extension.ClientOperationHash != "payload-hash" {
					t.Fatalf("extension changed: %+v", extension)
				}
				var receipt struct{ ResultJSON, TurnID string }
				if err := db.Table("agent_op_records").Where("op_id = ?", "operation").Scan(&receipt).Error; err != nil {
					t.Fatal(err)
				}
				if receipt.ResultJSON != `{"taskId":"task"}` || receipt.TurnID != "turn" {
					t.Fatalf("receipt changed: %+v", receipt)
				}
				if !db.Migrator().HasIndex("tasks", "idx_tasks_user_client_op") {
					t.Fatal("lost idempotency index")
				}
			}
			if history == "image-v3" {
				var row model.ImageSubmission
				if err := db.First(&row, "attempt_id = ?", "attempt").Error; err != nil {
					t.Fatal(err)
				}
				if row.SendCount != 5 || row.RequestCipher != "opaque-fixture" {
					t.Fatalf("recovery reset: %+v", row)
				}
			}
		})
	}
}
