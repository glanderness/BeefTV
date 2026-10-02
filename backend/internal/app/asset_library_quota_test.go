package app

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func TestCommitGeneratedAssetsRejectsBatchOverAssetLimitAndRollsBack(t *testing.T) {
	svc, db, _ := newResourceDeletionTestService(t)
	if err := db.AutoMigrate(&model.AdminAuditEvent{}); err != nil {
		t.Fatal(err)
	}
	actor := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	policy := defaultRuntimePolicy()
	policy.Resource.AssetCount = 2
	if _, err := svc.UpdateRuntimePolicySetting(actor, policy); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := db.Create(&model.Asset{
		ID: "existing", UserID: "owner", Kind: "text", Title: "已有",
		PayloadJSON: `{"id":"existing","kind":"text","title":"已有"}`, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"res-a", "res-b"} {
		if err := db.Create(&model.Resource{
			ID: id, UserID: "owner", Kind: "image", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: id + ".png", CreatedAt: now, UpdatedAt: now,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	assetA := json.RawMessage(`{"id":"asset-a","kind":"image","title":"A","coverUrl":"/api/resources/res-a/file","tags":[],"data":{"dataUrl":"/api/resources/res-a/file","storageKey":"resource:res-a","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	assetB := json.RawMessage(`{"id":"asset-b","kind":"image","title":"B","coverUrl":"/api/resources/res-b/file","tags":[],"data":{"dataUrl":"/api/resources/res-b/file","storageKey":"resource:res-b","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	canvas := json.RawMessage(`{"id":"canvas","revision":0,"title":"生成","nodes":[],"connections":[]}`)
	_, err := svc.CommitUserCanvasProjectAssets("owner", canvas, []json.RawMessage{assetA, assetB})
	var quota *AppError
	if err == nil || !errors.As(err, &quota) || quota.Code != CodeQuotaExceeded {
		t.Fatalf("commit error = %v", err)
	}
	if _, err := svc.repo.AssetForUser("owner", "asset-a"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("asset-a persisted after quota failure: %v", err)
	}
	if _, err := svc.repo.AssetForUser("owner", "asset-b"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("asset-b persisted after quota failure: %v", err)
	}
	if _, err := svc.repo.CanvasProjectForUser("owner", "canvas"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("canvas persisted after quota failure: %v", err)
	}
}
