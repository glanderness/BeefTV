package assistantturns_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type testCanvasFactory struct {
	base *canvas.Service
}

func (f testCanvasFactory) BoundTo(tx *gorm.DB) assistantturns.CanvasSession {
	svc := f.base
	if tx != nil {
		svc = f.base.WithRepository(repository.New(tx))
	}
	return testCanvasSession{svc: svc}
}

type testCanvasSession struct{ svc *canvas.Service }

func (s testCanvasSession) UserCanvasProject(userID, canvasID string) (json.RawMessage, error) {
	return s.svc.UserCanvasProject(userID, canvasID)
}

func (s testCanvasSession) UpsertUserCanvasProject(userID string, raw json.RawMessage) (int64, error) {
	summary, err := s.svc.UpsertUserCanvasProject(userID, raw)
	if err != nil {
		return 0, err
	}
	return summary.Revision, nil
}

type turnFixture struct {
	db       *gorm.DB
	path     string
	dir      string
	repo     *repository.Repository
	canvas   *canvas.Service
	turns    *assistantturns.Service
	userID   string
	canvasID string
}

func openTurnFixture(t *testing.T) *turnFixture {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.db")
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	canv := canvas.New(repo, nil)
	turns := assistantturns.New(assistantturns.NewStore(repo), testCanvasFactory{base: canv}, filepath.Join(dir, "assistant-turns"))
	fx := &turnFixture{db: db, path: path, dir: dir, repo: repo, canvas: canv, turns: turns, userID: "local", canvasID: "canvas-1"}
	fx.writeCanvas(t, map[string]any{
		"id": fx.canvasID, "title": "回合", "revision": 0,
		"nodes":       []any{map[string]any{"id": "n1", "type": "text", "title": "原节点", "position": map[string]any{"x": 0, "y": 0}}},
		"connections": []any{},
	})
	return fx
}

func (fx *turnFixture) writeCanvas(t *testing.T, doc map[string]any) int64 {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := fx.canvas.UpsertUserCanvasProject(fx.userID, raw)
	if err != nil {
		t.Fatal(err)
	}
	return summary.Revision
}

func (fx *turnFixture) readCanvas(t *testing.T) map[string]any {
	t.Helper()
	raw, err := fx.canvas.UserCanvasProject(fx.userID, fx.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func (fx *turnFixture) revision(t *testing.T) int64 {
	t.Helper()
	return assistantturns.DocumentRevision(fx.readCanvas(t))
}

func (fx *turnFixture) appendNode(t *testing.T, nodeID string) int64 {
	t.Helper()
	doc := fx.readCanvas(t)
	nodes, _ := doc["nodes"].([]any)
	doc["nodes"] = append(nodes, map[string]any{"id": nodeID, "type": "text", "title": nodeID, "position": map[string]any{"x": 10, "y": 10}})
	return fx.writeCanvas(t, doc)
}

func (fx *turnFixture) receipt(t *testing.T, turnID, opID, op string, payload map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Create(&model.AgentOpRecord{UserID: fx.userID, OpID: opID, Op: op, Status: "succeeded", ResultJSON: string(encoded), TurnID: turnID}).Error; err != nil {
		t.Fatal(err)
	}
}

func (fx *turnFixture) reopen(t *testing.T) *turnFixture {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(fx.path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	repo := repository.New(db)
	canv := canvas.New(repo, nil)
	turns := assistantturns.New(assistantturns.NewStore(repo), testCanvasFactory{base: canv}, filepath.Join(fx.dir, "assistant-turns"))
	return &turnFixture{db: db, path: fx.path, dir: fx.dir, repo: repo, canvas: canv, turns: turns, userID: fx.userID, canvasID: fx.canvasID}
}

func TestBeginReplaySameIDKeepsSnapshot(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223344"
	before, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}})
	if err != nil {
		t.Fatal(err)
	}
	fx.appendNode(t, "n2")
	again, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}})
	if err != nil {
		t.Fatal(err)
	}
	if again != before {
		t.Fatalf("replay overwrote snapshot revision: %d -> %d", before, again)
	}
	rec, err := fx.turns.Load(turnID)
	if err != nil {
		t.Fatal(err)
	}
	if rec.RevisionBefore != before || rec.State != assistantturns.StateOpen {
		t.Fatalf("snapshot mutated: %+v", rec)
	}
}

func TestBeginSameIDDifferentScopeRejected(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223345"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}}); err != nil {
		t.Fatal(err)
	}
	_, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a2"}})
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonIDCollision {
		t.Fatalf("expected collision, got %v", err)
	}
}

func TestBeginRequiresActorIdentity(t *testing.T) {
	fx := openTurnFixture(t)
	if _, err := fx.turns.Begin("", fx.canvasID, "aabbccdd11223346", assistantturns.Input{}); err == nil {
		t.Fatal("empty user must fail")
	}
	if _, err := fx.turns.Begin(fx.userID, "", "aabbccdd11223346", assistantturns.Input{}); err == nil {
		t.Fatal("empty canvas must fail")
	}
}

func TestForeignOwnerCannotUndoOrReadScope(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223347"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if _, ok, err := fx.turns.ScopeForHost("other", turnID); err != nil || ok {
		t.Fatalf("foreign scope leaked: ok=%v err=%v", ok, err)
	}
	if _, err := fx.turns.Undo("other", fx.canvasID, turnID); err == nil {
		t.Fatal("foreign undo must fail")
	}
	if fx.turns.Undone("other", fx.canvasID, turnID) {
		t.Fatal("foreign undone leaked")
	}
}

func TestStaleClosedScopeRejected(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223348"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := fx.turns.ScopeForHost(fx.userID, turnID); err != nil || !ok {
		t.Fatalf("open scope missing: %v", err)
	}
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := fx.turns.ScopeForHost(fx.userID, turnID); ok {
		t.Fatal("settled turn still open for host")
	}
	if err := fx.db.Transaction(func(tx *gorm.DB) error {
		return fx.turns.VerifyOpenTurnInTx(tx, fx.userID, turnID, fx.canvasID)
	}); err == nil {
		t.Fatal("verify after settle must fail")
	}
}

func TestInterruptedFinalizeKeepsOpenSnapshot(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223349"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Create(&model.AgentOpRecord{UserID: fx.userID, OpID: "bad", Op: "canvas.node.update", Status: "succeeded", ResultJSON: "{invalid", TurnID: turnID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fx.turns.Finalize(turnID); err == nil {
		t.Fatal("corrupt receipt must fail finalize")
	}
	rec, err := fx.turns.Load(turnID)
	if err != nil || rec.State != assistantturns.StateOpen || len(rec.Document) == 0 {
		t.Fatalf("snapshot lost: %+v %v", rec, err)
	}
}

func TestFailedUndoMarkerRollsBackCanvas(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334a"
	before, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{})
	if err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected marker failure")
	_, err = fx.turns.WithUndoMarkerHook(func() error { return injected }).Undo(fx.userID, fx.canvasID, turnID)
	if !errors.Is(err, injected) {
		t.Fatalf("got %v", err)
	}
	if fx.revision(t) != after {
		t.Fatalf("canvas restore survived marker failure: %d (before %d after %d)", fx.revision(t), before, after)
	}
	if fx.turns.Undone(fx.userID, fx.canvasID, turnID) {
		t.Fatal("undone marker committed after rollback")
	}
	nodes, _ := fx.readCanvas(t)["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("node set changed: %v", nodes)
	}
}

func TestLaterEditsNotLostOnUndo(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334b"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	fx.appendNode(t, "n3")
	_, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCanvasChanged {
		t.Fatalf("got %v", err)
	}
	nodes, _ := fx.readCanvas(t)["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("later edit lost: %v", nodes)
	}
}

func TestReopenReadsDurableState(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334c"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	reopened := fx.reopen(t)
	if !reopened.turns.Undone(fx.userID, fx.canvasID, turnID) {
		t.Fatal("undo marker missing after reopen")
	}
	if _, ok, _ := reopened.turns.ScopeForHost(fx.userID, turnID); ok {
		t.Fatal("undone turn still open after reopen")
	}
}

func TestLegacyJSONImportIsIdempotent(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334d"
	doc, err := json.Marshal(fx.readCanvas(t))
	if err != nil {
		t.Fatal(err)
	}
	legacy := map[string]any{
		"turnId": turnID, "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 0, "createdAt": "2026-01-02T03:04:05.000000000Z",
		"state": "open", "selectedNodeIds": []string{"n1"},
		"referencedAssetIds": []string{"asset-1"}, "undone": false,
		"document": json.RawMessage(doc),
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, turnID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	scope, ok, err := fx.turns.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || scope.CanvasID != fx.canvasID {
		t.Fatalf("import failed: %+v %v %v", scope, ok, err)
	}
	if !contains(scope.AssetIDs, "asset-1") {
		t.Fatalf("imported assets: %v", scope.AssetIDs)
	}
	scope2, ok, err := fx.turns.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || scope2.CanvasID != scope.CanvasID {
		t.Fatalf("reimport changed record: %+v %v", scope2, err)
	}
	if _, err := os.Stat(filepath.Join(dir, turnID+".json")); err != nil {
		t.Fatal("legacy file was deleted")
	}
}

func TestCorruptLegacyFileIsObservable(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334e"
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, turnID+".json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := fx.turns.ScopeForHost(fx.userID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCorruptFile {
		t.Fatalf("corrupt file hidden: %v", err)
	}
}

func TestOwnershipMismatchOnLegacyFileIsObservable(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334f"
	raw, _ := json.Marshal(map[string]any{
		"turnId": "aaaaaaaaaaaaaaaa", "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 0, "state": "open", "document": map[string]any{"id": fx.canvasID},
	})
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, turnID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := fx.turns.ScopeForHost(fx.userID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonOwnership {
		t.Fatalf("ownership mismatch hidden: %v", err)
	}
}

func TestSimultaneousUnrelatedWorkspacesHaveNoGlobalLock(t *testing.T) {
	left := openTurnFixture(t)
	right := openTurnFixture(t)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := left.turns.Begin(left.userID, left.canvasID, "aaaaaaaaaaaaaaaa", assistantturns.Input{})
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := right.turns.Begin(right.userID, right.canvasID, "bbbbbbbbbbbbbbbb", assistantturns.Input{})
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, ok, _ := left.turns.ScopeForHost(left.userID, "aaaaaaaaaaaaaaaa"); !ok {
		t.Fatal("left turn missing")
	}
	if _, ok, _ := right.turns.ScopeForHost(right.userID, "bbbbbbbbbbbbbbbb"); !ok {
		t.Fatal("right turn missing")
	}
}

func TestRetentionSkipsOpenTurns(t *testing.T) {
	fx := openTurnFixture(t)
	openID := "ffffffffffffffff"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, openID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 70; i++ {
		id := hexID(i)
		if _, err := fx.turns.Begin(fx.userID, fx.canvasID, id, assistantturns.Input{}); err != nil {
			t.Fatal(err)
		}
		if err := fx.turns.Finalize(id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, "eeeeeeeeeeeeeeee", assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	rec, err := fx.turns.Load(openID)
	if err != nil || rec.State != assistantturns.StateOpen {
		t.Fatalf("open turn pruned: %+v %v", rec, err)
	}
}

func TestVerifyOpenTurnInTxAllowsOpenRound(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223350"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Transaction(func(tx *gorm.DB) error {
		return fx.turns.VerifyOpenTurnInTx(tx, fx.userID, turnID, fx.canvasID)
	}); err != nil {
		t.Fatal(err)
	}
}

func hexID(n int) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 16)
	for i := range out {
		out[i] = '0'
	}
	for i := 15; n > 0 && i >= 0; i-- {
		out[i] = digits[n%16]
		n /= 16
	}
	out[0] = 'c'
	return string(out)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
