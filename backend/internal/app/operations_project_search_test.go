package app

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"strings"
	"testing"
)

func TestProjectSearchUsesRealLinksAndRechecksMembership(t *testing.T) {
	svc, db := newProjectAssetLinkTestService(t)
	svc.dataDir = t.TempDir()
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.SystemSetting{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []model.Project{{ID: "p1", UserID: "owner", Name: "first", Status: model.ProjectStatusActive}, {ID: "p2", UserID: "owner", Name: "second", Status: model.ProjectStatusActive}, {ID: "foreign", UserID: "other", Name: "secret", Status: model.ProjectStatusActive}} {
		if err := db.Create(&p).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []model.CanvasProject{{ID: "current", UserID: "owner", ProjectID: "p1", Title: "Current", PayloadJSON: `{"id":"current","nodes":[]}`}, {ID: "same", UserID: "owner", ProjectID: "p1", Title: "Same", PayloadJSON: `{"nodes":[]}`}, {ID: "unrelated", UserID: "owner", ProjectID: "p2", Title: "Secret", PayloadJSON: `{"nodes":[]}`}, {ID: "other-owner", UserID: "other", ProjectID: "p1", Title: "Foreign", PayloadJSON: `{"nodes":[]}`}, {ID: "standalone", UserID: "owner", PayloadJSON: `{"nodes":[]}`}} {
		if err := db.Create(&c).Error; err != nil {
			t.Fatal(err)
		}
	}
	var picture bytes.Buffer
	png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	resource, err := svc.UploadResourceFile("owner", "picture.png", int64(picture.Len()), "image", 2, 2, 0, bytes.NewReader(picture.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	standaloneDocument := `{"nodes":[{"id":"direct","type":"image","title":"Reference","metadata":{"storageKey":"resource:` + resource.ID + `"}}]}`
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", "standalone").Update("payload_json", standaloneDocument).Error; err != nil {
		t.Fatal(err)
	}
	for _, a := range []model.Asset{{ID: "linked", UserID: "owner", Title: "Interview", Kind: "image", PayloadJSON: `{"id":"linked","title":"Interview","kind":"image","resourceId":"` + resource.ID + `"}`}, {ID: "spoof", UserID: "owner", Title: "Secret", Kind: "video", PayloadJSON: `{"id":"spoof","title":"Secret","kind":"video","metadata":{"projectName":"p1","projectIds":["p1"]}}`}, {ID: "foreign-asset", UserID: "other", Title: "Secret", Kind: "video", PayloadJSON: `{"id":"foreign-asset","title":"Secret","kind":"video"}`}} {
		if err := db.Create(&a).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, link := range []model.ProjectAssetLink{{ID: "l1", ProjectID: "p1", AssetID: "linked"}, {ID: "l2", ProjectID: "p1", AssetID: "foreign-asset"}} {
		if err := db.Create(&link).Error; err != nil {
			t.Fatal(err)
		}
	}
	session := svc.BindDomain(nil).(operations.ProjectSearch)
	standalone, err := session.SearchAgentProject("owner", "standalone", "media", "Reference", "image", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	standaloneRaw, _ := json.Marshal(standalone)
	if !strings.Contains(string(standaloneRaw), "direct") || strings.Contains(string(standaloneRaw), "linked") {
		t.Fatalf("standalone scope %s", standaloneRaw)
	}
	second, err := session.SearchAgentProject("owner", "standalone", "media", "Reference", "image", 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	secondRaw, _ := json.Marshal(second)
	if strings.Contains(string(secondRaw), "direct") {
		t.Fatalf("pagination repeated item %s", secondRaw)
	}
	found, err := session.SearchAgentProject("owner", "current", "media", "", "", 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(found)
	if !strings.Contains(string(raw), "linked") || strings.Contains(string(raw), "Secret") || strings.Contains(string(raw), "foreign") || strings.Contains(string(raw), "projectCounts") {
		t.Fatalf("project leaked/empty %s", raw)
	}
	found, err = session.SearchAgentProject("owner", "current", "canvas", "", "", 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(found)
	if !strings.Contains(string(raw), "same") || strings.Contains(string(raw), "unrelated") || strings.Contains(string(raw), "other-owner") {
		t.Fatalf("canvas leakage %s", raw)
	}
	scope := &agentops.AssistantScope{CanvasID: "current", ProjectReference: func(kind, id string) error { return svc.ValidateAgentProjectReference("owner", "current", kind, id) }}
	registry := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	run := func(op string, params any) (operations.Result, error) {
		raw, _ := json.Marshal(params)
		return registry.Execute(operations.Request{UserID: "owner", Op: op, Params: raw, Caller: operations.AssistantCaller(scope, false)})
	}
	overview, err := run("media.overview", map[string]any{"canvasId": "current", "assetId": "linked"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(overview.Result)
	var media operations.MediaResult
	if err := json.Unmarshal(encoded, &media); err != nil {
		t.Fatal(err)
	}
	if media.Source.Version == "" {
		t.Fatalf("missing actual source version %+v", overview)
	}
	if _, err := run("media.inspect", map[string]any{"canvasId": "current", "assetId": "linked", "expectedVersion": media.Source.Version}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"spoof", "foreign-asset"} {
		if _, err := run("asset.get", map[string]any{"assetId": id}); err == nil {
			t.Fatalf("unauthorized %s", id)
		}
	}
	if err := db.Where("id = ?", "l1").Delete(&model.ProjectAssetLink{}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := run("media.inspect", map[string]any{"canvasId": "current", "assetId": "linked", "expectedVersion": media.Source.Version}); err == nil {
		t.Fatal("revoked search result still readable")
	}
	db.Create(&model.ProjectAssetLink{ID: "l3", ProjectID: "p1", AssetID: "linked"})
	db.Model(&model.CanvasProject{}).Where("id = ?", "current").Update("project_id", "p2")
	if _, err := run("asset.get", map[string]any{"assetId": "linked"}); err == nil {
		t.Fatal("project switch preserved old search authorization")
	}
	if err := svc.ValidateAgentProjectReference("owner", "standalone", "asset", "linked"); err == nil {
		t.Fatal("standalone expanded library")
	}
	// 同回合内新生成并绑定到独立画布节点的自有素材，即使不在回合初 AssetIDs 快照里也应允许按 assetId 审片；
	// 但未绑定到该画布的自有素材或他人素材仍必须拒绝。
	boundAsset := model.Asset{
		ID:          "bound-in-turn",
		UserID:      "owner",
		Title:       "Bound Result",
		Kind:        "image",
		PayloadJSON: `{"id":"bound-in-turn","title":"Bound Result","kind":"image","resourceId":"` + resource.ID + `"}`,
	}
	if err := db.Create(&boundAsset).Error; err != nil {
		t.Fatal(err)
	}
	boundDoc := `{"nodes":[{"id":"direct","type":"image","title":"Reference","metadata":{"assetId":"bound-in-turn","storageKey":"resource:` + resource.ID + `"}},{"id":"spoof-foreign","type":"image","title":"Spoof","metadata":{"assetId":"foreign-asset","storageKey":"resource:` + resource.ID + `"}}]}`
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", "standalone").Update("payload_json", boundDoc).Error; err != nil {
		t.Fatal(err)
	}
	standaloneScope := &agentops.AssistantScope{
		CanvasID: "standalone",
		ProjectReference: func(kind, id string) error {
			return svc.ValidateAgentProjectReference("owner", "standalone", kind, id)
		},
	}
	runStandalone := func(op string, params any) (operations.Result, error) {
		raw, _ := json.Marshal(params)
		return registry.Execute(operations.Request{UserID: "owner", Op: op, Params: raw, Caller: operations.AssistantCaller(standaloneScope, false)})
	}
	if _, err := runStandalone("media.overview", map[string]any{"canvasId": "standalone", "assetId": " bound-in-turn "}); err != nil {
		t.Fatalf("same-turn bound asset on standalone canvas should be readable by assetId: %v", err)
	}
	if _, err := runStandalone("asset.get", map[string]any{"assetId": "bound-in-turn"}); err != nil {
		t.Fatalf("same-turn bound asset on standalone canvas should pass asset.get: %v", err)
	}
	if _, err := runStandalone("media.overview", map[string]any{"canvasId": "standalone", "assetId": "linked"}); err == nil {
		t.Fatal("unbound owner asset on standalone canvas must remain denied")
	}
	if _, err := runStandalone("media.overview", map[string]any{"canvasId": "standalone", "assetId": "foreign-asset"}); err == nil {
		t.Fatal("foreign asset must remain denied even if its assetId appears in canvas payload")
	}
	// 项目画布撤回项目链接后，即使画布节点 payload 仍留有该素材的 assetId，也不得绕过 ProjectAssetLink 校验。
	projectDocWithLinked := `{"id":"current","nodes":[{"id":"n-linked","type":"image","title":"Linked","metadata":{"assetId":"linked","storageKey":"resource:` + resource.ID + `"}}]}`
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", "current").Updates(map[string]any{"project_id": "p1", "payload_json": projectDocWithLinked}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Where("project_id = ? AND asset_id = ?", "p1", "linked").Delete(&model.ProjectAssetLink{}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := run("media.overview", map[string]any{"canvasId": "current", "assetId": "linked"}); err == nil {
		t.Fatal("revoked project link must stay denied even when canvas payload still references assetId")
	}
	if _, err := run("asset.get", map[string]any{"assetId": "linked"}); err == nil {
		t.Fatal("revoked project link asset.get must stay denied even when canvas payload still references assetId")
	}
	db.Create(&model.ProjectAssetLink{ID: "l4", ProjectID: "p1", AssetID: "linked"})
	page, err := svc.CanvasService().UserAssetsPage("owner", 1, 20, canvas.UserAssetPageFilter{ProjectID: "p1"})
	if err != nil || len(page.Assets) != 1 || len(page.ProjectCounts) != 0 {
		t.Fatalf("scoped filter=%+v err=%v", page, err)
	}
}
