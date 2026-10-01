package asset

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newDeletionDomain(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	repo := repository.New(db)
	svc := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
	})
	return svc, db, dataDir
}

func TestOccupiedMessageNamesBusinessRecord(t *testing.T) {
	message := OccupiedMessage([]ResourceUsage{
		{Kind: "画布", ID: "canvas-1", Title: "广告分镜"},
		{Kind: "画布", ID: "canvas-1", Title: "广告分镜"},
	})
	if !strings.Contains(message, "画布「广告分镜」") || !strings.Contains(message, "解除引用") {
		t.Fatalf("message = %q", message)
	}
}

func TestDeleteLocalObjectRemovesOnlyResourceDirectoryFile(t *testing.T) {
	dataDir := t.TempDir()
	resourcePath := filepath.Join(dataDir, "resources", "users", "user-1", "image", "asset.png")
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	svc := NewService(Dependencies{Blobs: NewFileStore(dataDir)})
	if err := svc.DeleteLocalObject("users/user-1/image/asset.png"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resourcePath); !os.IsNotExist(err) {
		t.Fatalf("resource file still exists: %v", err)
	}
	outsidePath := filepath.Join(dataDir, "outside.txt")
	if err := os.WriteFile(outsidePath, []byte("keep"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteLocalObject("../outside.txt"); err == nil {
		t.Fatal("path traversal should be rejected")
	}
	if _, err := os.Stat(outsidePath); err != nil {
		t.Fatalf("outside file was changed: %v", err)
	}
}

func TestDeleteAssetKeepsLiveCanvasReference(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	resource := model.Resource{ID: "resource-canvas", UserID: "user-1", Provider: "local", ObjectKey: "users/user-1/image/canvas.png", Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-canvas", UserID: "user-1", Title: "画布素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-canvas"}}`}
	canvas := model.CanvasProject{ID: "canvas-live", UserID: "user-1", Title: "仍在使用的画布", PayloadJSON: `{"nodes":[{"data":{"storageKey":"resource:resource-canvas"}}]}`}
	for _, item := range []any{&resource, &asset, &canvas} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	err := svc.DeleteUserAssetWithResources("user-1", asset.ID)
	if err == nil || !strings.Contains(err.Error(), "画布「仍在使用的画布」") {
		t.Fatalf("DeleteUserAssetWithResources() error = %v, want live canvas reference", err)
	}
	var assetCount, resourceCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 || resourceCount != 1 {
		t.Fatalf("blocked delete changed data: asset=%d resource=%d", assetCount, resourceCount)
	}
}

func TestDeletionWorkerRemovesObjectAndCompletesOutbox(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/queued.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	job := model.ResourceDeletionJob{
		ID: "deletion-1", UserID: "user-1", ResourceID: "resource-1",
		Provider: "local", ObjectKey: objectKey,
		Status: model.ResourceDeletionStatusPending, NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	svc.DrainDeletionJobs(1)
	if _, err := os.Stat(resourcePath); !os.IsNotExist(err) {
		t.Fatalf("queued physical object was not deleted: %v", err)
	}
	var count int64
	if err := db.Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("completed deletion job was not removed")
	}
}

func TestDetachedCleanupKeepsReferencedResource(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	old := time.Now().Add(-48 * time.Hour)
	orphan := model.Resource{
		ID: "resource-detached", UserID: "user-1", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/detached.png",
		CreatedAt: old, UpdatedAt: old,
	}
	backed := model.Resource{
		ID: "resource-backed", UserID: "user-1", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/backed.png",
		CreatedAt: old, UpdatedAt: old,
	}
	asset := model.Asset{
		ID: "asset-backed", UserID: "user-1", Title: "素材库图片",
		PayloadJSON: `{"data":{"storageKey":"resource:resource-backed"}}`, CreatedAt: old, UpdatedAt: old,
	}
	for _, item := range []any{&orphan, &backed, &asset} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.CleanupDetachedUserResources("user-1", []model.Resource{orphan, backed}); err != nil {
		t.Fatal(err)
	}
	var orphanCount, backedCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", orphan.ID).Count(&orphanCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", backed.ID).Count(&backedCount).Error; err != nil {
		t.Fatal(err)
	}
	if orphanCount != 0 || backedCount != 1 {
		t.Fatalf("cleanup result: orphan=%d backed=%d", orphanCount, backedCount)
	}
}

func TestDeleteStoredObjectRejectsForeignOwnerForgedIdentity(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/owned.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "resource-owned", UserID: "user-1", Provider: "local", ObjectKey: objectKey,
		Status: model.ResourceStatusReady,
	}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	forged := &model.Resource{
		ID: resource.ID, UserID: "user-2", Provider: "local",
		ObjectKey: objectKey, Status: model.ResourceStatusReady,
	}
	if err := svc.DeleteStoredObject("user-2", forged); err == nil {
		t.Fatal("foreign delete succeeded")
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("owned file was removed: %v", err)
	}
	missing := &model.Resource{
		ID: "missing-id", UserID: "user-2", Provider: "local", ObjectKey: objectKey,
	}
	if err := svc.DeleteStoredObject("user-2", missing); err == nil {
		t.Fatal("missing-id delete succeeded")
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("owned file was removed via missing id: %v", err)
	}
}

func TestDeleteStoredObjectUsesPersistedObjectKey(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	ownedKey := "users/user-1/image/owned.png"
	decoyKey := "users/user-1/image/decoy.png"
	for _, key := range []string{ownedKey, decoyKey} {
		path := filepath.Join(dataDir, "resources", filepath.FromSlash(key))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(key), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	resource := model.Resource{
		ID: "resource-persisted", UserID: "user-1", Provider: "local", ObjectKey: ownedKey,
		Status: model.ResourceStatusReady,
	}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	forged := &model.Resource{
		ID: resource.ID, UserID: "user-1", Provider: "local", ObjectKey: decoyKey,
	}
	if err := svc.DeleteStoredObject("user-1", forged); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(ownedKey))); !os.IsNotExist(err) {
		t.Fatalf("persisted object still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(decoyKey))); err != nil {
		t.Fatalf("forged object key was deleted: %v", err)
	}
}

func TestDeleteAssetAndResourcesAbortsWhenLiveCanvasAppears(t *testing.T) {
	_, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/live.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "resource-live", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-live", UserID: "user-1", Title: "素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-live"}}`}
	canvas := model.CanvasProject{ID: "canvas-live", UserID: "user-1", Title: "画布", PayloadJSON: `{"nodes":[{"data":{"storageKey":"resource:resource-live"}}]}`}
	for _, item := range []any{&resource, &asset, &canvas} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(db)
	job := model.ResourceDeletionJob{
		ID: "should-not-commit", UserID: "user-1", ResourceID: resource.ID,
		Provider: "local", ObjectKey: objectKey, Status: model.ResourceDeletionStatusPending,
	}
	err := repo.DeleteAssetAndResources("user-1", asset.ID, []string{resource.ID}, []model.ResourceDeletionJob{job})
	if !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("DeleteAssetAndResources() error = %v", err)
	}
	var assetCount, resourceCount, jobCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 || resourceCount != 1 || jobCount != 0 {
		t.Fatalf("tx leaked: asset=%d resource=%d job=%d", assetCount, resourceCount, jobCount)
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("bytes removed while delete aborted: %v", err)
	}
}

func TestDeleteAssetEnqueuesOutboxWithoutRemovingBytes(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/queued-keep.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "resource-keep", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-keep", UserID: "user-1", Title: "可删素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-keep"}}`}
	for _, item := range []any{&resource, &asset} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.DeleteUserAssetWithResources("user-1", asset.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("metadata commit removed bytes: %v", err)
	}
	var resourceCount, jobCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if resourceCount != 0 || jobCount != 1 {
		t.Fatalf("outbox state: resource=%d job=%d", resourceCount, jobCount)
	}
}

func TestDeletionWorkerRetriesFailedPhysicalDelete(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	job := model.ResourceDeletionJob{
		ID: "deletion-retry", UserID: "user-1", ResourceID: "resource-missing",
		Provider: "local", ObjectKey: "../escape",
		Status: model.ResourceDeletionStatusPending, NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	svc.DrainDeletionJobs(1)
	var remaining model.ResourceDeletionJob
	if err := db.First(&remaining, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if remaining.Status != model.ResourceDeletionStatusPending || remaining.Attempts == 0 || remaining.LastError == "" {
		t.Fatalf("retry job = %#v", remaining)
	}
}
