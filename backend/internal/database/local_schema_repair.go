package database

import (
	"fmt"
	"slices"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

type sqliteIndexContract struct {
	table, name string
	columns     []string
	unique      bool
}

var reconciledIndexes = []sqliteIndexContract{
	{"tasks", "idx_tasks_user_client_op", []string{"user_id", "client_operation_id"}, true},
	{"agent_op_records", "idx_agent_op_records_turn_id", []string{"turn_id"}, false},
}

// Names alone do not prove uniqueness, scope or column order. All names here
// are compile-time schema identifiers, never user-provided SQL.
func matchesSQLiteIndex(db *gorm.DB, expected sqliteIndexContract) (bool, error) {
	var indexes []struct {
		Name    string
		Unique  int
		Partial int
	}
	if err := db.Raw("PRAGMA index_list(" + expected.table + ")").Scan(&indexes).Error; err != nil {
		return false, fmt.Errorf("读取本地索引: %w", err)
	}
	for _, index := range indexes {
		if index.Name != expected.name {
			continue
		}
		if (index.Unique == 1) != expected.unique || index.Partial != 0 {
			return false, nil
		}
		var columns []struct{ Name string }
		if err := db.Raw("PRAGMA index_info(" + expected.name + ")").Scan(&columns).Error; err != nil {
			return false, err
		}
		actual := make([]string, len(columns))
		for i, column := range columns {
			actual[i] = column.Name
		}
		return slices.Equal(actual, expected.columns), nil
	}
	return false, nil
}

// v9 repairs v8 fixtures through an explicit transaction and a new ledger
// entry. A failed unique-index repair preserves every row and the old ledger.
func repairProductAgentContracts(tx *gorm.DB) error {
	// A missing primary key is not safely repaired by an additive migration.
	// Refuse existing malformed identity tables before AutoMigrate can rebuild.
	for table, columns := range map[string][]string{"tasks": {"id"}, "image_submissions": {"attempt_id"}, "agent_op_records": {"user_id", "op_id"}} {
		if tx.Migrator().HasTable(table) {
			if err := requireSQLitePrimaryKey(tx, table, columns); err != nil {
				return err
			}
		}
	}
	if err := migrateProductAgentSchema(tx); err != nil {
		return err
	}
	for _, index := range reconciledIndexes {
		valid, err := matchesSQLiteIndex(tx, index)
		if err != nil {
			return err
		}
		if valid {
			continue
		}
		var value any = &model.Task{}
		if index.table == "agent_op_records" {
			value = &model.AgentOpRecord{}
		}
		if tx.Migrator().HasIndex(value, index.name) {
			if err := tx.Migrator().DropIndex(value, index.name); err != nil {
				return err
			}
		}
		if err := tx.Migrator().CreateIndex(value, index.name); err != nil {
			return fmt.Errorf("修复索引 %s: %w", index.name, err)
		}
	}
	// Validate inside the migration transaction, before advancing the ledger.
	return requireReconciledSchema(tx)
}

func requireSQLitePrimaryKey(db *gorm.DB, table string, expected []string) error {
	var columns []struct {
		Name string
		PK   int
	}
	if err := db.Raw("PRAGMA table_info(" + table + ")").Scan(&columns).Error; err != nil {
		return err
	}
	actual := make([]string, len(expected))
	for _, column := range columns {
		if column.PK == 0 {
			continue
		}
		if column.PK > len(actual) {
			return fmt.Errorf("本地数据库表 %s 主键定义不完整，拒绝自动修复", table)
		}
		actual[column.PK-1] = column.Name
	}
	if !slices.Equal(actual, expected) {
		return fmt.Errorf("本地数据库表 %s 主键定义不完整，拒绝自动修复", table)
	}
	return nil
}
