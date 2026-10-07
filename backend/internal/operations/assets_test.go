package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/canvas"
)

// assetWriteProbe 记录 handler 写入素材库的文档，模拟真实领域的 upsert 行为。
type assetWriteProbe struct {
	unusedDomain
	stored  map[string]json.RawMessage
	deleted []string
	upserts int
}

func (p *assetWriteProbe) UserAsset(_ string, id string) (json.RawMessage, error) {
	if document, exists := p.stored[id]; exists {
		return document, nil
	}
	return nil, NotFound("not_found", "素材不存在")
}

func (p *assetWriteProbe) UpsertUserAsset(_ string, raw json.RawMessage) (canvas.UserDataSummary, error) {
	p.upserts++
	var payload struct {
		ID    string `json:"id"`
		Kind  string `json:"kind"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return canvas.UserDataSummary{}, err
	}
	if payload.ID == "" {
		payload.ID = "asset-new"
	}
	p.stored[payload.ID] = raw
	return canvas.UserDataSummary{ID: payload.ID, Kind: payload.Kind, Title: payload.Title}, nil
}

func (p *assetWriteProbe) DeleteUserAsset(_ string, id string, _ ...string) error {
	p.deleted = append(p.deleted, id)
	return nil
}

func newAssetWriteProbe() *assetWriteProbe {
	return &assetWriteProbe{stored: map[string]json.RawMessage{
		"a1": json.RawMessage(`{"id":"a1","kind":"text","title":"夜巷台词","tags":["场景"],"data":{"content":"旧正文"}}`),
	}}
}

func TestOpAssetCreateBuildsTextDocument(t *testing.T) {
	probe := newAssetWriteProbe()
	result, err := opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"kind":"text","title":"夜巷台词","tags":["场景","夜戏"],"content":"你终于回来了"}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.upserts != 1 {
		t.Fatalf("upserts = %d", probe.upserts)
	}
	var document map[string]any
	if err := json.Unmarshal(probe.stored["asset-new"], &document); err != nil {
		t.Fatal(err)
	}
	if document["kind"] != "text" || document["title"] != "夜巷台词" {
		t.Fatalf("document = %#v", document)
	}
	if content, _ := document["data"].(map[string]any); content["content"] != "你终于回来了" {
		t.Fatalf("data = %#v", document["data"])
	}
	if cover, ok := document["coverUrl"].(string); !ok || cover != "" {
		t.Fatalf("coverUrl = %#v", document["coverUrl"])
	}
	payload := result.(map[string]any)
	if payload["assetId"] != "asset-new" || payload["kind"] != "text" {
		t.Fatalf("回执 = %#v", payload)
	}
}

// 媒体类素材必须拒绝：外部入口不伪造媒体定位符。
func TestOpAssetCreateRejectsMediaKinds(t *testing.T) {
	probe := newAssetWriteProbe()
	_, err := opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"kind":"image","title":"假图","content":"x"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "unsupported_kind" {
		t.Fatalf("媒体类素材应被拒绝，实际 %v", err)
	}
	if probe.upserts != 0 {
		t.Fatal("不应写入素材库")
	}
}

func TestOpAssetCreateValidatesContent(t *testing.T) {
	probe := newAssetWriteProbe()
	if _, err := opAssetCreate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"kind":"text","title":"  "}`)); err == nil {
		t.Fatal("空标题应被拒绝")
	}
	if _, err := opAssetCreate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"kind":"text","title":"无正文","content":"  "}`)); err == nil {
		t.Fatal("空正文应被拒绝")
	}
	if _, err := opAssetCreate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"kind":"entity","title":"无定义"}`)); err == nil {
		t.Fatal("空 definition 应被拒绝")
	}
	if _, err := opAssetCreate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"kind":"text","title":"`+strings.Repeat("长", 241)+`","content":"x"}`)); err == nil {
		t.Fatal("超长标题应被拒绝")
	}
}

func TestOpAssetUpdatePatchesOnlyMetaFields(t *testing.T) {
	probe := newAssetWriteProbe()
	result, err := opAssetUpdate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"assetId":"a1","title":"新标题","favorite":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(probe.stored["a1"], &document); err != nil {
		t.Fatal(err)
	}
	if document["title"] != "新标题" || document["favorite"] != true {
		t.Fatalf("patch 未生效: %#v", document)
	}
	if data, _ := document["data"].(map[string]any); data["content"] != "旧正文" {
		t.Fatalf("媒体/内容 data 必须逐字保留: %#v", document["data"])
	}
	if tags, _ := document["tags"].([]any); len(tags) != 1 || tags[0] != "场景" {
		t.Fatalf("未给出的 tags 应保留: %#v", document["tags"])
	}
	payload := result.(map[string]any)
	if payload["assetId"] != "a1" || payload["title"] != "新标题" {
		t.Fatalf("回执 = %#v", payload)
	}
}

func TestOpAssetUpdateRejectsEmptyPatchAndUnknownAsset(t *testing.T) {
	probe := newAssetWriteProbe()
	if _, err := opAssetUpdate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"assetId":"a1"}`)); err == nil {
		t.Fatal("空 patch 应被拒绝")
	}
	_, err := opAssetUpdate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"assetId":"missing","title":"x"}`))
	if !isNotFoundError(err) {
		t.Fatalf("未知素材应返回 404，实际 %v", err)
	}
}

// 白名单外字段（如 data）必须被 unknown_field 拒绝，防止绕过元字段约束。
func TestOpAssetUpdateRejectsUnknownField(t *testing.T) {
	probe := newAssetWriteProbe()
	_, err := opAssetUpdate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"assetId":"a1","data":{"content":"篡改"}}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "unknown_field" {
		t.Fatalf("应拒绝白名单外字段，实际 %v", err)
	}
}

// 删除必须带素材当前标题；标题不匹配拒绝且不进领域。
func TestOpAssetDeleteRequiresTitleConfirmation(t *testing.T) {
	probe := newAssetWriteProbe()
	if _, err := opAssetDelete(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"assetId":"a1"}`)); err == nil {
		t.Fatal("缺 expectedTitle 应被拒绝")
	}
	_, err := opAssetDelete(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"assetId":"a1","expectedTitle":"别的标题"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "title_mismatch" {
		t.Fatalf("标题不匹配应拒绝删除，实际 %v", err)
	}
	if len(probe.deleted) != 0 {
		t.Fatal("标题不匹配时不应进领域")
	}
	if _, err := opAssetDelete(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"assetId":"a1","expectedTitle":"夜巷台词"}`)); err != nil {
		t.Fatal(err)
	}
	if len(probe.deleted) != 1 || probe.deleted[0] != "a1" {
		t.Fatalf("deleted = %#v", probe.deleted)
	}
}
