package asset

import (
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newLibraryFixture(t *testing.T) (*Library, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+filepath.Join(t.TempDir(), "library.db")+"?_busy_timeout=5000&_journal_mode=WAL&_txlock=immediate"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Asset{}, &model.AssetFolder{}, &model.Resource{}, &model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	return NewLibrary(repository.New(db), nil), db
}

func testLibraryAssetPayload(kind string, extra map[string]any) map[string]any {
	payload := map[string]any{
		"id": "asset-1", "kind": kind, "title": "测试资产", "coverUrl": "", "tags": []string{},
	}
	switch kind {
	case "image":
		payload["data"] = map[string]any{"dataUrl": "https://example.com/a.png", "width": 1, "height": 1, "bytes": 1, "mimeType": "image/png"}
	case "video":
		payload["data"] = map[string]any{"url": "https://example.com/a.mp4", "width": 1, "height": 1, "bytes": 1, "mimeType": "video/mp4"}
	case "audio":
		payload["data"] = map[string]any{"url": "https://example.com/a.mp3", "bytes": 1, "mimeType": "audio/mpeg"}
	case "model":
		payload["data"] = map[string]any{"url": "https://example.com/a.glb", "bytes": 1, "mimeType": "model/gltf-binary", "fileName": "a.glb"}
	case "text":
		payload["data"] = map[string]any{"content": "正文"}
	default:
		payload["data"] = map[string]any{"definition": map[string]any{}}
	}
	for key, value := range extra {
		payload[key] = value
	}
	return payload
}

func TestLibraryDoesNotDependOnAppOrCanvas(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("list asset deps: %v\n%s", err, output)
	}
	for _, dependency := range strings.Fields(string(output)) {
		switch dependency {
		case "infinite-canvas/backend/internal/app", "infinite-canvas/backend/internal/canvas":
			t.Fatalf("asset library depends on %s", dependency)
		}
	}
}

func TestAssetFromJSONAcceptsDeterministicGenerationID(t *testing.T) {
	id := "generation_" + strings.Repeat("a", 64)
	raw, err := json.Marshal(testLibraryAssetPayload("image", map[string]any{"id": id, "title": "生成图片", "source": "生成任务"}))
	if err != nil {
		t.Fatal(err)
	}
	item, err := AssetFromJSON("user-1", raw)
	if err != nil {
		t.Fatal(err)
	}
	if item.ID != id {
		t.Fatalf("id = %q", item.ID)
	}
	if !strings.Contains(item.PayloadJSON, `"source":"生成任务"`) {
		t.Fatalf("source metadata dropped: %s", item.PayloadJSON)
	}
}

func TestUserAssetBytesRequiresNonNegativeNumber(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio", "model"} {
		for _, raw := range []string{"null", " null ", `"12"`, "-1", "true", "{}", "[]", "1e400", "0", "12"} {
			t.Run(kind+"/"+raw, func(t *testing.T) {
				data := map[string]json.RawMessage{
					"dataUrl": json.RawMessage(`"https://example.com/file"`),
					"url":     json.RawMessage(`"https://example.com/file"`),
					"width":   json.RawMessage("1"), "height": json.RawMessage("1"),
					"mimeType": json.RawMessage(`"application/octet-stream"`),
					"fileName": json.RawMessage(`"file.glb"`),
					"bytes":    json.RawMessage(raw),
				}
				err := validateUserAssetData(kind, data)
				valid := raw == "0" || raw == "12"
				if (err == nil) != valid {
					t.Fatalf("bytes=%s: error=%v, want valid=%v", raw, err, valid)
				}
				delete(data, "bytes")
				if err := validateUserAssetData(kind, data); err == nil {
					t.Fatal("missing bytes accepted")
				}
			})
		}
	}
}

func TestMalformedPayloadReadUnchanged(t *testing.T) {
	lib, db := newLibraryFixture(t)
	now := time.Now().UTC()
	corrupt := `{not-json`
	item := model.Asset{
		ID: "asset-corrupt", UserID: "owner", Kind: "image", Title: "损坏",
		PayloadJSON: corrupt, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	raw, err := lib.UserAsset("owner", "asset-corrupt")
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != corrupt {
		t.Fatalf("malformed payload changed: %q", raw)
	}
}

func TestLibraryRejectsForeignAndAcceptsOwnedResource(t *testing.T) {
	lib, db := newLibraryFixture(t)
	now := time.Now().UTC()
	owned := model.Resource{ID: "res-owned", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "owned.png", CreatedAt: now, UpdatedAt: now}
	foreign := model.Resource{ID: "res-foreign", UserID: "other", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "foreign.png", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&owned).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}

	ownedRaw, err := json.Marshal(testLibraryAssetPayload("image", map[string]any{
		"id": "asset-owned", "coverUrl": "/api/resources/res-owned/file",
		"data": map[string]any{"dataUrl": "/api/resources/res-owned/file", "storageKey": "resource:res-owned", "width": 1, "height": 1, "bytes": 1, "mimeType": "image/png"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lib.UpsertUserAsset("owner", ownedRaw); err != nil {
		t.Fatalf("owned resource rejected: %v", err)
	}

	foreignRaw, err := json.Marshal(testLibraryAssetPayload("image", map[string]any{
		"id": "asset-foreign", "coverUrl": "/api/resources/res-foreign/file",
		"data": map[string]any{"dataUrl": "/api/resources/res-foreign/file", "storageKey": "resource:res-foreign", "width": 1, "height": 1, "bytes": 1, "mimeType": "image/png"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = lib.UpsertUserAsset("owner", foreignRaw)
	if err == nil || !strings.Contains(err.Error(), "不存在或不属于当前用户") {
		t.Fatalf("foreign resource error = %v", err)
	}
	if _, err := lib.repo.AssetForUser("owner", "asset-foreign"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("foreign resource asset persisted: %v", err)
	}
}

func TestPersistPreparedAssetsRollsBackWithCallerTransaction(t *testing.T) {
	lib, _ := newLibraryFixture(t)
	raw, err := json.Marshal(testLibraryAssetPayload("image", map[string]any{"id": "generation_rollback"}))
	if err != nil {
		t.Fatal(err)
	}
	item, err := AssetFromJSON("owner", raw)
	if err != nil {
		t.Fatal(err)
	}
	err = lib.repo.Transaction(func(tx *repository.Repository) error {
		if _, persistErr := lib.WithRepository(tx).PersistPreparedAssets("owner", []model.Asset{item}); persistErr != nil {
			return persistErr
		}
		return errors.New("force rollback")
	})
	if err == nil {
		t.Fatal("expected rollback error")
	}
	if _, err := lib.repo.AssetForUser("owner", "generation_rollback"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("asset survived caller rollback: %v", err)
	}
}

func TestClientAssetPayloadPreservesCompleteDocument(t *testing.T) {
	rawInput := `{"id":"asset-1","kind":"image","title":"完整","coverUrl":"https://example.com/a.png","tags":["角色"],"source":"生成任务","createdAt":"2026-08-29T00:00:00.000Z","updatedAt":"2026-08-29T00:00:00.000Z","data":{"dataUrl":"https://example.com/a.png","width":2,"height":3,"bytes":1,"mimeType":"image/png"}}`
	raw := ClientAssetPayload(model.Asset{PayloadJSON: rawInput})
	var before map[string]any
	var after map[string]any
	if err := json.Unmarshal([]byte(rawInput), &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &after); err != nil {
		t.Fatal(err)
	}
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(after)
	if string(beforeJSON) != string(afterJSON) {
		t.Fatalf("payload changed: %s", raw)
	}
}

func TestUpsertRejectsMissingFolderInsideTransaction(t *testing.T) {
	lib, _ := newLibraryFixture(t)
	raw, err := json.Marshal(testLibraryAssetPayload("image", map[string]any{"id": "asset-missing-folder", "folderId": "missing"}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = lib.UpsertUserAsset("owner", raw)
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || !strings.Contains(err.Error(), "素材分类不存在") {
		t.Fatalf("error = %v", err)
	}
}
