package asset

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestCleanupDetachedUserResourcesProtectsImageHistoryOnlyAndAssetlessCanvasResources(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	histOnly := model.Resource{
		ID: "res-hist-only", UserID: "owner", Provider: "local",
		ObjectKey: "users/owner/image/hist-only.png", MimeType: "image/png", Status: model.ResourceStatusReady,
	}
	nodeOnly := model.Resource{
		ID: "res-node-only", UserID: "owner", Provider: "local",
		ObjectKey: "users/owner/image/node-only.png", MimeType: "image/png", Status: model.ResourceStatusReady,
	}
	orphan := model.Resource{
		ID: "res-orphan", UserID: "owner", Provider: "local",
		ObjectKey: "users/owner/image/orphan.png", MimeType: "image/png", Status: model.ResourceStatusReady,
	}
	for _, r := range []model.Resource{histOnly, nodeOnly, orphan} {
		if err := db.Create(&r).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Zero Asset rows exist for res-hist-only or res-node-only: both live only in CanvasProject.PayloadJSON.
	canvasDoc := model.CanvasProject{
		ID: "canvas-hist-gc", UserID: "owner", Title: "History GC", Revision: 1,
		PayloadJSON: `{
			"id":"canvas-hist-gc",
			"title":"History GC",
			"nodes":[{
				"id":"img-1",
				"type":"image",
				"metadata":{
					"storageKey":"resource:res-node-only",
					"content":"/api/resources/res-node-only/file",
					"imageHistory":[
						{"id":"old-task:0","storageKey":"resource:res-hist-only","content":"/api/resources/res-hist-only/file"},
						{"id":"old-task:1","storageKey":"resource:res-node-only","content":"/api/resources/res-node-only/file"}
					]
				}
			}],
			"connections":[]
		}`,
	}
	if err := db.Create(&canvasDoc).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.CleanupDetachedUserResources("owner", []model.Resource{histOnly, nodeOnly, orphan}); err != nil {
		t.Fatalf("CleanupDetachedUserResources() error = %v", err)
	}

	var remaining []model.Resource
	if err := db.Order("id ASC").Find(&remaining).Error; err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 2 || remaining[0].ID != "res-hist-only" || remaining[1].ID != "res-node-only" {
		t.Fatalf("expected res-hist-only and res-node-only to survive and res-orphan to be deleted, got: %+v", remaining)
	}

	repo := repository.New(db)
	if err := repo.DeleteDetachedResources([]model.Resource{histOnly}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("DeleteDetachedResources(histOnly) = %v, want ErrResourceCleanupStillReferenced", err)
	}
}

func TestDeleteUserAssetRetainsPhysicalResourceWhenReferencedOnlyInCanvasImageHistory(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	histRes := model.Resource{
		ID: "res-hist-asset", UserID: "owner", Provider: "local",
		ObjectKey: "users/owner/image/hist-asset.png", MimeType: "image/png", Status: model.ResourceStatusReady,
	}
	if err := db.Create(&histRes).Error; err != nil {
		t.Fatal(err)
	}
	assetRow := model.Asset{
		ID: "asset-hist-1", UserID: "owner", Kind: "image", Title: "历史图",
		PayloadJSON: `{"id":"asset-hist-1","data":{"storageKey":"resource:res-hist-asset","dataUrl":"/api/resources/res-hist-asset/file"}}`,
	}
	if err := db.Create(&assetRow).Error; err != nil {
		t.Fatal(err)
	}
	canvasDoc := model.CanvasProject{
		ID: "canvas-del-asset", UserID: "owner", Title: "Delete Asset Check", Revision: 1,
		PayloadJSON: `{
			"id":"canvas-del-asset",
			"title":"Delete Asset Check",
			"nodes":[{
				"id":"img-1",
				"type":"image",
				"metadata":{
					"imageHistory":[
						{"id":"h1","storageKey":"resource:res-hist-asset","content":"/api/resources/res-hist-asset/file"}
					]
				}
			}],
			"connections":[]
		}`,
	}
	if err := db.Create(&canvasDoc).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.DeleteUserAssetWithResources("owner", "asset-hist-1"); err != nil {
		t.Fatalf("DeleteUserAssetWithResources() error = %v", err)
	}

	var assetCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", "asset-hist-1").Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 0 {
		t.Fatalf("expected Asset row to be deleted, count = %d", assetCount)
	}
	var resCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", "res-hist-asset").Count(&resCount).Error; err != nil {
		t.Fatal(err)
	}
	if resCount != 1 {
		t.Fatalf("expected Resource row referenced by canvas imageHistory to be retained, count = %d", resCount)
	}
}

func TestGuardReplacementCanvasReferencesSkipsUnboundCanvasMediaNodes(t *testing.T) {
	lib, db := newLibraryFixture(t)
	canvasDoc := model.CanvasProject{
		ID: "canvas-unbound-node", UserID: "owner", Title: "Unbound Node", Revision: 1,
		PayloadJSON: `{
			"id":"canvas-unbound-node",
			"title":"Unbound Node",
			"nodes":[{
				"id":"img-unbound",
				"type":"image",
				"metadata":{"storageKey":"resource:res-unbound","content":"/api/resources/res-unbound/file"}
			}],
			"connections":[]
		}`,
	}
	if err := db.Create(&canvasDoc).Error; err != nil {
		t.Fatal(err)
	}
	if err := lib.GuardReplacementCanvasReferences("owner", nil); err != nil {
		t.Fatalf("GuardReplacementCanvasReferences() error = %v, want nil for assetless media node", err)
	}
}
