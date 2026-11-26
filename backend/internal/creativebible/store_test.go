package creativebible

import (
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
)

func openBibleTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "bible.db")), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestCreativeBibleCRUDRevisionCASAndScopeResolution(t *testing.T) {
	db := openBibleTestDB(t)
	userID := "owner-1"

	if err := db.Create(&model.Project{ID: "proj-1", UserID: userID, Name: "赛博雨夜"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{ID: "canvas-in-proj", UserID: userID, ProjectID: "proj-1", Title: "第一集", PayloadJSON: "{}"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{ID: "canvas-solo", UserID: userID, Title: "独立画布", PayloadJSON: "{}"}).Error; err != nil {
		t.Fatal(err)
	}

	// Scope resolution: project-linked canvas shares project bible; solo canvas uses its own.
	kind, scopeID, err := ResolveScopeForCanvas(db, userID, "canvas-in-proj")
	if err != nil || kind != ScopeProject || scopeID != "proj-1" {
		t.Fatalf("expected project scope proj-1, got (%q, %q, %v)", kind, scopeID, err)
	}
	kind2, scopeID2, err := ResolveScopeForCanvas(db, userID, "canvas-solo")
	if err != nil || kind2 != ScopeCanvas || scopeID2 != "canvas-solo" {
		t.Fatalf("expected canvas scope canvas-solo, got (%q, %q, %v)", kind2, scopeID2, err)
	}

	// Empty bible produces empty digest (zero prompt overhead).
	initial, err := Get(db, userID, ScopeProject, "proj-1")
	if err != nil {
		t.Fatal(err)
	}
	if !initial.IsEmpty() || FormatDigest(initial) != "" {
		t.Fatalf("expected empty initial bible and empty digest, got %+v", initial)
	}

	// Save v1 with characters, locations, style, and taboos.
	rev0 := int64(0)
	title := "赛博雨夜 · 第一季"
	visualStyle := "35mm 电影实拍质感，潮湿反光街道"
	taboos := "禁止二次元大眼，禁止字幕水印"
	chars := []CharacterEntry{
		{Name: "林岚", Appearance: "28岁短发女侦探，左眉淡疤", Wardrobe: "炭灰风衣", Voice: "沉稳低沉女声"},
	}
	locs := []LocationEntry{
		{Name: "旧港区天台", Description: "生锈铁网与霓虹灯牌", Lighting: "青蓝雨夜+琥珀暖光"},
	}
	saved, err := Save(db, userID, ScopeProject, "proj-1", UpdateInput{
		ExpectedRevision: &rev0,
		Title:            &title,
		VisualStyle:      &visualStyle,
		Taboos:           &taboos,
		Characters:       &chars,
		Locations:        &locs,
	})
	if err != nil {
		t.Fatalf("save v1 failed: %v", err)
	}
	if saved.Revision != 1 || saved.IsEmpty() {
		t.Fatalf("unexpected saved v1: %+v", saved)
	}
	digest := FormatDigest(saved)
	for _, want := range []string{"赛博雨夜", "35mm 电影实拍质感", "林岚", "炭灰风衣", "旧港区天台", "禁止二次元大眼"} {
		if !strings.Contains(digest, want) {
			t.Fatalf("digest missing %q:\n%s", want, digest)
		}
	}

	// Stale revision must be rejected with conflict.
	newStyle := "手绘水彩"
	if _, err := Save(db, userID, ScopeProject, "proj-1", UpdateInput{
		ExpectedRevision: &rev0,
		VisualStyle:      &newStyle,
	}); err == nil {
		t.Fatal("expected revision conflict when saving with stale expectedRevision=0")
	}

	// Correct revision succeeds and preserves untouched fields.
	rev1 := int64(1)
	saved2, err := Save(db, userID, ScopeProject, "proj-1", UpdateInput{
		ExpectedRevision: &rev1,
		VisualStyle:      &newStyle,
	})
	if err != nil {
		t.Fatalf("save v2 failed: %v", err)
	}
	if saved2.Revision != 2 || saved2.VisualStyle != newStyle || len(saved2.Characters) != 1 || saved2.Taboos != taboos {
		t.Fatalf("expected partial merge preserving characters/taboos, got %+v", saved2)
	}
}
