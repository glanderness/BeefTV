package operations

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
)

// assetWriteProbe 记录 handler 写入素材库的文档，模拟真实领域的 upsert 行为。
type assetWriteProbe struct {
	unusedDomain
	stored      map[string]json.RawMessage
	deleted     []string
	upserts     int
	resource    *model.Resource
	uploadCalls []uploadCall
}

type uploadCall struct {
	fileName string
	size     int64
	kind     string
	width    int
	height   int
	identity []string
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

func (p *assetWriteProbe) UploadLocalFile(_ string, fileName string, size int64, kind string, width int, height int, _ int64, file io.ReadSeeker, identity ...string) (*model.Resource, error) {
	p.uploadCalls = append(p.uploadCalls, uploadCall{fileName: fileName, size: size, kind: kind, width: width, height: height, identity: identity})
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	if len(data) != int(size) {
		return nil, InvalidArg("invalid_params", "读取字节数与 size 不一致")
	}
	resource := &model.Resource{ID: "res-up", Kind: kind, Status: model.ResourceStatusReady,
		MimeType: "image/png", Size: size, Width: width, Height: height}
	p.resource = resource
	return resource, nil
}

func (p *assetWriteProbe) OwnedReadyResource(_ string, resourceID string) (*model.Resource, error) {
	if p.resource != nil && resourceID == p.resource.ID {
		return p.resource, nil
	}
	return nil, NotFound("not_found", "资源不存在")
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

// 不带 resourceId 的媒体类素材必须拒绝：外部入口不伪造媒体定位符。
func TestOpAssetCreateRejectsMediaKindsWithoutResource(t *testing.T) {
	probe := newAssetWriteProbe()
	_, err := opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"kind":"image","title":"假图","content":"x"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "unsupported_kind" {
		t.Fatalf("无资源 ID 的媒体类素材应被拒绝，实际 %v", err)
	}
	if probe.upserts != 0 {
		t.Fatal("不应写入素材库")
	}
}

// 带 resourceId 的媒体素材：元数据全部取自资源记录，构造对齐工作流产物落素材的形状。
func TestOpAssetCreateRegistersMediaAssetFromResource(t *testing.T) {
	probe := newAssetWriteProbe()
	probe.resource = &model.Resource{ID: "res-1", Kind: "image", Status: model.ResourceStatusReady,
		MimeType: "image/png", Size: 2048, Width: 1024, Height: 768}
	result, err := opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"resourceId":"res-1","title":"夜巷首帧","tags":["分镜"]}`))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(probe.stored["asset-new"], &document); err != nil {
		t.Fatal(err)
	}
	if document["kind"] != "image" || document["coverUrl"] != "/api/resources/res-1/file" {
		t.Fatalf("document = %#v", document)
	}
	data, _ := document["data"].(map[string]any)
	if data["storageKey"] != "resource:res-1" || data["mimeType"] != "image/png" {
		t.Fatalf("data = %#v", data)
	}
	if data["width"] != float64(1024) || data["height"] != float64(768) || data["bytes"] != float64(2048) {
		t.Fatalf("尺寸/大小未取自资源记录: %#v", data)
	}
	if data["dataUrl"] != "/api/resources/res-1/file" {
		t.Fatalf("dataUrl = %#v", data["dataUrl"])
	}
	payload := result.(map[string]any)
	if payload["kind"] != "image" || payload["assetId"] != "asset-new" {
		t.Fatalf("回执 = %#v", payload)
	}
}

func TestOpAssetCreateMediaValidatesResource(t *testing.T) {
	probe := newAssetWriteProbe()
	// 资源不存在。
	_, err := opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"resourceId":"missing","title":"x"}`))
	if !isNotFoundError(err) {
		t.Fatalf("未知资源应 404，实际 %v", err)
	}
	// kind 与资源类型不一致。
	probe.resource = &model.Resource{ID: "res-1", Kind: "video", Status: model.ResourceStatusReady,
		MimeType: "video/mp4", Size: 1, Width: 0, Height: 0, DurationMs: 6400}
	_, err = opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"resourceId":"res-1","kind":"image","title":"x"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "kind_mismatch" {
		t.Fatalf("kind 不一致应拒绝，实际 %v", err)
	}
	// resourceId 与 content 互斥。
	_, err = opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"resourceId":"res-1","title":"x","content":"正文"}`))
	opErr, ok = err.(*Error)
	if !ok || opErr.Reason != "invalid_params" {
		t.Fatalf("互斥参数应拒绝，实际 %v", err)
	}
	// 视频资源：宽高未知时保留 0，时长并入 data。
	result, err := opAssetCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"resourceId":"res-1","title":"镜头视频"}`))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(probe.stored["asset-new"], &document); err != nil {
		t.Fatal(err)
	}
	data, _ := document["data"].(map[string]any)
	if data["url"] != "/api/resources/res-1/file" || data["durationMs"] != float64(6400) {
		t.Fatalf("video data = %#v", data)
	}
	if result.(map[string]any)["kind"] != "video" {
		t.Fatal("kind 应由资源类型推导为 video")
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

// writeTestPNG 在临时目录生成一张真实 PNG，返回绝对路径与文件字节。
func writeTestPNG(t *testing.T, width, height int) string {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		picture.Set(x, 0, color.RGBA{R: 255, A: 255})
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "codex-output.png")
	if err := os.WriteFile(path, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// asset.upload：本机图片 → 资源库 → 素材，宽高由服务端解码文件得到。
func TestOpAssetUploadRegistersLocalImage(t *testing.T) {
	probe := newAssetWriteProbe()
	path := writeTestPNG(t, 16, 9)
	result, err := opAssetUpload(&Context{UserID: "owner", Domain: probe, OpID: "op-1"},
		json.RawMessage(`{"filePath":"`+path+`","title":"Codex 生成图","tags":["AI"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(probe.uploadCalls) != 1 {
		t.Fatalf("uploadCalls = %#v", probe.uploadCalls)
	}
	call := probe.uploadCalls[0]
	if call.kind != "image" || call.width != 16 || call.height != 9 || call.fileName != "codex-output.png" {
		t.Fatalf("upload call = %#v", call)
	}
	if call.size <= 0 || len(call.identity) == 0 || !strings.Contains(call.identity[0], "op-1") {
		t.Fatalf("upload identity/size = %#v", call)
	}
	var document map[string]any
	if err := json.Unmarshal(probe.stored["asset-new"], &document); err != nil {
		t.Fatal(err)
	}
	if document["kind"] != "image" {
		t.Fatalf("document = %#v", document)
	}
	data, _ := document["data"].(map[string]any)
	if data["storageKey"] != "resource:res-up" || data["width"] != float64(16) {
		t.Fatalf("data = %#v", data)
	}
	payload := result.(map[string]any)
	if payload["assetId"] != "asset-new" || payload["resourceId"] != "res-up" {
		t.Fatalf("回执 = %#v", payload)
	}
}

func TestOpAssetUploadRejectsBadPathsAndNonImages(t *testing.T) {
	probe := newAssetWriteProbe()
	// 缺路径 / 相对路径 / 不存在。
	if _, err := opAssetUpload(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"filePath":"  ","title":"x"}`)); err == nil {
		t.Fatal("空路径应被拒绝")
	}
	if _, err := opAssetUpload(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"filePath":"relative.png","title":"x"}`)); err == nil {
		t.Fatal("相对路径应被拒绝")
	}
	if _, err := opAssetUpload(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"filePath":"/tmp/no-such-file.png","title":"x"}`)); err == nil {
		t.Fatal("不存在的文件应被拒绝")
	}
	// 存在但不是图片。
	textFile := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(textFile, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := opAssetUpload(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"filePath":"`+textFile+`","title":"x"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "unsupported_kind" {
		t.Fatalf("非图片应被拒绝，实际 %v", err)
	}
	if len(probe.uploadCalls) != 0 {
		t.Fatal("不应触达上传")
	}
}
