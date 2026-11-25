package database

import (
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

func TestV31WorkspaceReferencedResourcesMigrationPreservesRounds(t *testing.T) {
	file := filepath.Join(t.TempDir(), "v31-copy.sqlite")
	db, err := gorm.Open(sqlite.Open(file), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("DELETE FROM local_schema_migrations WHERE version >= 32").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE assistant_turns DROP COLUMN referenced_resource_ids").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE assistant_turns ADD COLUMN private_preview_note TEXT").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO assistant_turns(turn_id,user_id,canvas_id,state,document,private_preview_note) VALUES('dddddddd11111111','local','canvas','open','{"nodes":[]}','keep')`).Error; err != nil {
		t.Fatal(err)
	}
	var before []localSchemaMigration
	db.Order("version").Find(&before)
	sqlDB, _ := db.DB()
	sqlDB.Close()

	db, err = gorm.Open(sqlite.Open(file), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ = db.DB()
	defer sqlDB.Close()
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var turn model.AssistantTurn
	if err := db.First(&turn, "turn_id = ?", "dddddddd11111111").Error; err != nil {
		t.Fatal(err)
	}
	if turn.State != "open" || turn.Document != `{"nodes":[]}` || turn.ReferencedResourceIDs != "" {
		t.Fatalf("round changed: %+v", turn)
	}
	var note string
	db.Raw("SELECT private_preview_note FROM assistant_turns WHERE turn_id = ?", "dddddddd11111111").Scan(&note)
	if note != "keep" {
		t.Fatal("unknown column lost")
	}
	var after []localSchemaMigration
	db.Order("version").Find(&after)
	if len(after) != len(canonicalLocalMigrations()) {
		t.Fatalf("ledger=%+v", after)
	}
	for i, row := range before {
		if row.Name != after[i].Name || !row.AppliedAt.Equal(after[i].AppliedAt) {
			t.Fatal("historical ledger changed")
		}
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	db.Exec("ALTER TABLE assistant_turns DROP COLUMN referenced_resource_ids")
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v32 missing referenced_resource_ids column accepted")
	}
}
