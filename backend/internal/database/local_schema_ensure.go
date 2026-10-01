package database

import (
	"fmt"

	"gorm.io/gorm"
)

func sqliteHasColumn(db *gorm.DB, table, column string) (bool, error) {
	var columns []struct{ Name string }
	if err := db.Raw("PRAGMA table_info(" + table + ")").Scan(&columns).Error; err != nil {
		return false, fmt.Errorf("读取本地表 %s 列: %w", table, err)
	}
	for _, item := range columns {
		if item.Name == column {
			return true, nil
		}
	}
	return false, nil
}

func sqliteHasNamedIndex(db *gorm.DB, table, name string) (bool, error) {
	var indexes []struct{ Name string }
	if err := db.Raw("PRAGMA index_list(" + table + ")").Scan(&indexes).Error; err != nil {
		return false, fmt.Errorf("读取本地表 %s 索引: %w", table, err)
	}
	for _, index := range indexes {
		if index.Name == name {
			return true, nil
		}
	}
	return false, nil
}

func ensureSQLiteColumn(tx *gorm.DB, table, column, definition string) error {
	if !tx.Migrator().HasTable(table) {
		return fmt.Errorf("本地数据库表 %s 不存在，无法添加列 %s", table, column)
	}
	has, err := sqliteHasColumn(tx, table, column)
	if err != nil {
		return err
	}
	if has {
		return nil
	}
	if err := tx.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition).Error; err != nil {
		return fmt.Errorf("添加本地数据库列 %s.%s: %w", table, column, err)
	}
	return nil
}

func ensureSQLiteIndex(tx *gorm.DB, table, name, createSQL string) error {
	has, err := sqliteHasNamedIndex(tx, table, name)
	if err != nil {
		return err
	}
	if has {
		return nil
	}
	if err := tx.Exec(createSQL).Error; err != nil {
		return fmt.Errorf("创建本地数据库索引 %s: %w", name, err)
	}
	return nil
}

func ensureTaskFailureDiagnostics(tx *gorm.DB) error {
	return ensureSQLiteColumn(tx, "tasks", "failure_diagnostics", "TEXT")
}

func ensureTaskClientOperation(tx *gorm.DB) error {
	if err := ensureSQLiteColumn(tx, "tasks", "client_operation_id", "TEXT"); err != nil {
		return err
	}
	return ensureTaskUserClientOpIndex(tx)
}

func ensureTaskClientOperationHash(tx *gorm.DB) error {
	return ensureSQLiteColumn(tx, "tasks", "client_operation_hash", "TEXT")
}

func ensureTaskUserClientOpIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "tasks", "idx_tasks_user_client_op",
		"CREATE UNIQUE INDEX idx_tasks_user_client_op ON tasks(user_id, client_operation_id)")
}

func ensureAgentOperationTurnAttribution(tx *gorm.DB) error {
	if err := ensureAgentOpRecordsTable(tx); err != nil {
		return err
	}
	return ensureAgentOpTurnIndex(tx)
}

func ensureAgentOpRecordsTable(tx *gorm.DB) error {
	if tx.Migrator().HasTable("agent_op_records") {
		if err := ensureSQLiteColumn(tx, "agent_op_records", "op", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "payload_hash", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "status", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "result_json", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "turn_id", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "created_at", "DATETIME"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "updated_at", "DATETIME"); err != nil {
			return err
		}
		return ensureAgentOpTurnIndex(tx)
	}
	if err := tx.Exec(`CREATE TABLE agent_op_records (
		user_id TEXT,
		op_id TEXT,
		op TEXT,
		payload_hash TEXT,
		status TEXT,
		result_json TEXT,
		turn_id TEXT,
		created_at DATETIME,
		updated_at DATETIME,
		PRIMARY KEY (user_id, op_id)
	)`).Error; err != nil {
		return fmt.Errorf("创建 Agent 操作表: %w", err)
	}
	return ensureAgentOpTurnIndex(tx)
}

func ensureAgentOpTurnIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "agent_op_records", "idx_agent_op_records_turn_id",
		"CREATE INDEX idx_agent_op_records_turn_id ON agent_op_records(turn_id)")
}

func ensureImageSubmissionsTable(tx *gorm.DB) error {
	if tx.Migrator().HasTable("image_submissions") {
		if err := ensureSQLiteColumn(tx, "image_submissions", "task_id", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "user_id", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "request_cipher", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "send_count", "INTEGER"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "response_accepted", "NUMERIC"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "created_at", "DATETIME"); err != nil {
			return err
		}
		if err := ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_task_id",
			"CREATE INDEX idx_image_submissions_task_id ON image_submissions(task_id)"); err != nil {
			return err
		}
		return ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_user_id",
			"CREATE INDEX idx_image_submissions_user_id ON image_submissions(user_id)")
	}
	if err := tx.Exec(`CREATE TABLE image_submissions (
		attempt_id TEXT PRIMARY KEY,
		task_id TEXT,
		user_id TEXT,
		request_cipher TEXT,
		send_count INTEGER,
		response_accepted NUMERIC,
		created_at DATETIME
	)`).Error; err != nil {
		return fmt.Errorf("创建图片恢复表: %w", err)
	}
	if err := ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_task_id",
		"CREATE INDEX idx_image_submissions_task_id ON image_submissions(task_id)"); err != nil {
		return err
	}
	return ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_user_id",
		"CREATE INDEX idx_image_submissions_user_id ON image_submissions(user_id)")
}
