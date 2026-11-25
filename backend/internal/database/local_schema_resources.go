package database

import (
	"fmt"

	"gorm.io/gorm"
)

func migrateAssistantReferencedResources(tx *gorm.DB) error {
	if err := ensureSQLiteColumn(tx, "assistant_turns", "referenced_resource_ids", "TEXT"); err != nil {
		return err
	}
	return requireAssistantReferencedResources(tx)
}

func requireAssistantReferencedResources(db *gorm.DB) error {
	has, err := sqliteHasColumn(db, "assistant_turns", "referenced_resource_ids")
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("本地助手文件引用范围缺失，请启用自动迁移")
	}
	return nil
}
