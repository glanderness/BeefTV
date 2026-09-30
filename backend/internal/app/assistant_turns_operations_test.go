package app_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// External test package exercises the real operation store without an app ->
// agentops import cycle. No fabricated successful operation records.
type turnOperations struct {
	s *app.Service
	r *agentops.Registry
}

func newTurnOperations(t *testing.T) *turnOperations {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "turn.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "local"}).Error; err != nil {
		t.Fatal(err)
	}
	s := app.NewLocal(repository.New(db), t.TempDir())
	if _, err := s.UpsertUserCanvasProject("local", json.RawMessage(`{"id":"c","title":"original","revision":0,"nodes":[{"id":"S","type":"text","title":"original"}],"connections":[]}`)); err != nil {
		t.Fatal(err)
	}
	r := agentops.NewRegistry(s, agentops.NewStore(db))
	agentops.RegisterDefaultOps(r)
	return &turnOperations{s, r}
}

func (h *turnOperations) document(t *testing.T) map[string]any {
	t.Helper()
	raw, err := h.s.UserCanvasProject("local", "c")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func (h *turnOperations) run(t *testing.T, op, id string, params map[string]any) agentops.Result {
	t.Helper()
	params["canvasId"] = "c"
	params["expectedRevision"] = h.document(t)["revision"]
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	result, err := h.r.Execute(agentops.Request{UserID: "local", Op: op, OpID: id, Params: raw})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (h *turnOperations) record(t *testing.T, before int64, ids []string) {
	t.Helper()
	// JSON matches the host envelope; host node assertions are deliberately absent.
	raw, err := json.Marshal(map[string]any{"revisionBefore": before, "revisionAfter": h.document(t)["revision"], "operationIds": ids})
	if err != nil {
		t.Fatal(err)
	}
	var change app.AssistantTurnChange
	if err := json.Unmarshal(raw, &change); err != nil {
		t.Fatal(err)
	}
	if err := h.s.RecordAssistantTurnChange("aabbcc", &change); err != nil {
		t.Fatal(err)
	}
}

func TestUndoAssistantTurnVerifiedSequentialOperations(t *testing.T) {
	h := newTurnOperations(t)
	before, err := h.s.BeginAssistantTurn("local", "c", "aabbcc")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"first", "second"} {
		h.run(t, "canvas.nodes.create", id, map[string]any{"nodes": []any{map[string]any{"title": id, "type": "text"}}})
	}
	h.record(t, before, []string{"first", "second"})
	revision, err := h.s.UndoAssistantTurn("local", "c", "aabbcc")
	if err != nil {
		t.Fatalf("two committed assistant writes must undo: %v", err)
	}
	doc := h.document(t)
	if revision != before+3 || len(doc["nodes"].([]any)) != 1 {
		t.Fatalf("restore failed: %v", doc)
	}
}
