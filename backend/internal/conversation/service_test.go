package conversation_test

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"
)

func openConversationFixture(t *testing.T) (*gorm.DB, string, *conversation.Service) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "workspace.db")
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
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
	svc := conversation.New(conversation.NewStore(repository.New(db)))
	return db, path, svc
}

func reopenConversationFixture(t *testing.T, path string) (*gorm.DB, *conversation.Service) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	return db, conversation.New(conversation.NewStore(repository.New(db)))
}

func sampleDocument(id, title, messageID, taskID string) json.RawMessage {
	payload := map[string]any{
		"id":        id,
		"title":     title,
		"updatedAt": "2026-10-02T00:00:00.000Z",
		"messages": []any{
			map[string]any{"id": "user-1", "role": "user", "content": "镜头", "mode": "video"},
			map[string]any{
				"id": messageID, "role": "assistant", "mode": "video", "content": "", "status": "pending",
				"taskIds": []any{taskID}, "storageKey": "resource:shot-1",
			},
		},
	}
	raw, _ := json.Marshal(payload)
	return raw
}

func TestPutSurvivesRestart(t *testing.T) {
	_, path, svc := openConversationFixture(t)
	saved, err := svc.Put("local", "conversation-1", 0, sampleDocument("conversation-1", "第一镜", "assistant-1", "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 || saved.ID != "conversation-1" {
		t.Fatalf("saved = %+v", saved)
	}
	_, restarted := reopenConversationFixture(t, path)
	loaded, err := restarted.Get("local", "conversation-1")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != 1 {
		t.Fatalf("restart revision = %d", loaded.Revision)
	}
	var doc map[string]any
	if err := json.Unmarshal(loaded.Document, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["title"] != "第一镜" {
		t.Fatalf("restart document = %s", loaded.Document)
	}
}

func TestTwoCASWritersOneConflict(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	if _, err := svc.Put("local", "conversation-cas", 0, sampleDocument("conversation-cas", "原稿", "assistant-1", "task-1")); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]error, 2)
	revisions := make([]int64, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			title := "作者甲"
			if i == 1 {
				title = "作者乙"
			}
			record, err := svc.Put("local", "conversation-cas", 1, sampleDocument("conversation-cas", title, "assistant-1", "task-1"))
			results[i] = err
			if err == nil {
				revisions[i] = record.Revision
			}
		}(i)
	}
	close(start)
	wg.Wait()
	successes := 0
	conflicts := 0
	for i, err := range results {
		if err == nil {
			successes++
			if revisions[i] != 2 {
				t.Fatalf("winner revision = %d", revisions[i])
			}
			continue
		}
		var convErr *conversation.Error
		if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonConflict {
			t.Fatalf("writer %d error = %v", i, err)
		}
		conflicts++
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d errors=%v", successes, conflicts, results)
	}
	final, err := svc.Get("local", "conversation-cas")
	if err != nil || final.Revision != 2 {
		t.Fatalf("final = %+v err=%v", final, err)
	}
}

func TestInterruptedImportReplaysWithoutOverwrite(t *testing.T) {
	db, _, svc := openConversationFixture(t)
	raw := sampleDocument("conversation-import", "导入", "assistant-1", "task-1")
	injected := errors.New("injected import failure")
	err := db.Transaction(func(tx *gorm.DB) error {
		bound := svc.WithTx(tx)
		if _, importErr := bound.Import("local", "creation-conversations-v1:conversation-import", "", raw); importErr != nil {
			t.Fatal(importErr)
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatalf("tx error = %v", err)
	}
	if _, err := svc.Get("local", "conversation-import"); err == nil {
		t.Fatal("rolled back import still visible")
	}
	first, err := svc.Import("local", "creation-conversations-v1:conversation-import", "", raw)
	if err != nil || !first.Imported || first.Conversation.Revision != 1 {
		t.Fatalf("first import = %+v err=%v", first, err)
	}
	replay, err := svc.Import("local", "creation-conversations-v1:conversation-import", conversation.DocumentHash(first.Conversation.Document), raw)
	if err != nil || replay.Imported {
		t.Fatalf("replay = %+v err=%v", replay, err)
	}
	changed := sampleDocument("conversation-import", "被覆盖", "assistant-1", "task-1")
	_, hashErr := svc.Import("local", "creation-conversations-v1:conversation-import", "", changed)
	var convErr *conversation.Error
	if !errors.As(hashErr, &convErr) || convErr.Reason != conversation.ReasonConflict {
		t.Fatalf("changed hash error = %v", hashErr)
	}
	loaded, err := svc.Get("local", "conversation-import")
	if err != nil {
		t.Fatal(err)
	}
	if !jsonContains(loaded.Document, `"title":"导入"`) {
		t.Fatalf("import overwritten: %s", loaded.Document)
	}
}

func TestDeletedTombstoneNotResurrectedByLegacyImport(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	if _, err := svc.Put("local", "conversation-dead", 0, sampleDocument("conversation-dead", "旧对话", "assistant-1", "task-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Delete("local", "conversation-dead", 1); err != nil {
		t.Fatal(err)
	}
	list, err := svc.List("local")
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Conversations) != 0 || len(list.DeletedIDs) != 1 || list.DeletedIDs[0] != "conversation-dead" {
		t.Fatalf("list after delete = %+v", list)
	}
	imported, err := svc.Import("local", "creation-conversations-v1:conversation-dead", "", sampleDocument("conversation-dead", "复活", "assistant-1", "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	if imported.Imported || !imported.Deleted {
		t.Fatalf("tombstone resurrected: %+v", imported)
	}
	if _, err := svc.Get("local", "conversation-dead"); err == nil {
		t.Fatal("deleted conversation visible via get")
	}
	if _, err := svc.Put("local", "conversation-dead", 0, sampleDocument("conversation-dead", "复活", "assistant-1", "task-1")); err == nil {
		t.Fatal("put resurrected tombstone")
	}
}

func TestAttachMessageResultRollsBackWithCallerTx(t *testing.T) {
	db, _, svc := openConversationFixture(t)
	saved, err := svc.Put("local", "conversation-attach", 0, sampleDocument("conversation-attach", "待挂载", "assistant-1", "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected attach failure")
	err = db.Transaction(func(tx *gorm.DB) error {
		if _, attachErr := svc.WithTx(tx).AttachMessageResult("local", conversation.AttachInput{
			ConversationID: "conversation-attach",
			MessageID:      "assistant-1",
			TaskID:         "task-1",
			EffectKey:      "task-1:output:0",
			ResultURLs:     []string{"resource:result-1"},
			Status:         "done",
		}); attachErr != nil {
			t.Fatal(attachErr)
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatalf("tx error = %v", err)
	}
	loaded, err := svc.Get("local", "conversation-attach")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != saved.Revision || jsonContains(loaded.Document, "resource:result-1") {
		t.Fatalf("attach leaked across rollback: %s", loaded.Document)
	}
	attached, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-attach",
		MessageID:      "assistant-1",
		TaskID:         "task-1",
		EffectKey:      "task-1:output:0",
		ResultURLs:     []string{"resource:result-1"},
		Status:         "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if attached.Revision != saved.Revision+1 {
		t.Fatalf("attach revision = %d", attached.Revision)
	}
	replay, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-attach",
		MessageID:      "assistant-1",
		TaskID:         "task-1",
		EffectKey:      "task-1:output:0",
		ResultURLs:     []string{"resource:result-2"},
		Status:         "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Revision != attached.Revision || jsonContains(replay.Document, "resource:result-2") {
		t.Fatalf("effect key was not idempotent: %s", replay.Document)
	}
	if _, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-attach",
		MessageID:      "assistant-1",
		TaskID:         "task-other",
		ResultURLs:     []string{"resource:result-3"},
	}); err == nil {
		t.Fatal("attached result for unrelated task")
	}
	if jsonContains(replay.Document, `"title":"改名"`) {
		t.Fatal("attach changed title")
	}
}

func TestPutRejectsCredentialsAndKeepsUnknownFields(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	_, err := svc.Put("local", "conversation-secret", 0, json.RawMessage(`{"id":"conversation-secret","title":"x","messages":[],"apiKey":"sk-test"}`))
	var convErr *conversation.Error
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonInvalid {
		t.Fatalf("credential error = %v", err)
	}
	raw := json.RawMessage(`{"id":"conversation-keep","title":"保留","futureField":true,"messages":[{"id":"m1","role":"user","content":"hi","unknownLocator":"resource:keep","dataUrl":"data:image/png;base64,aaaa"}]}`)
	saved, err := svc.Put("local", "conversation-keep", 0, raw)
	if err != nil {
		t.Fatal(err)
	}
	if jsonContains(saved.Document, "data:image") || jsonContains(saved.Document, "sk-test") {
		t.Fatalf("blob or credential stored: %s", saved.Document)
	}
	if !jsonContains(saved.Document, `"futureField":true`) || !jsonContains(saved.Document, `"unknownLocator":"resource:keep"`) {
		t.Fatalf("unknown fields dropped: %s", saved.Document)
	}
}

func TestDeleteDoesNotRequireMissingLocalDraft(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	deleted, err := svc.Delete("local", "conversation-never", 0)
	if err != nil || !deleted.Deleted {
		t.Fatalf("missing local delete = %+v err=%v", deleted, err)
	}
}

func jsonContains(raw json.RawMessage, fragment string) bool {
	return strings.Contains(string(raw), fragment)
}
