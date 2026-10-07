package agentops_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// asset.upload 必须在操作写事务持有的唯一连接上完成上传全链路（配额预留、
// 资源落库、素材登记）。曾经走根仓储的写法会在单连接池里与操作事务互相
// 等待，客户端表现为"awaiting headers 超时"——本回归在真实 SQLite 单连接
// 环境下复现该场景。
func TestAssetUploadRegistersLocalFileWithinOperationTransaction(t *testing.T) {
	h := newHarness(t)

	var buffer bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 32, 18))
	for x := 0; x < 32; x++ {
		picture.Set(x, 0, color.RGBA{R: 255, A: 255})
	}
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(t.TempDir(), "codex-scene.png")
	if err := os.WriteFile(filePath, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	type uploadResult struct {
		result interface{}
		err    error
	}
	done := make(chan uploadResult, 1)
	go func() {
		result, err := h.run(t, "asset.upload", "upload-op-1", map[string]any{
			"filePath": filePath, "title": "Codex 场景图", "tags": []string{"AI"},
		}, false)
		done <- uploadResult{result: result.Result, err: err}
	}()
	select {
	case outcome := <-done:
		if outcome.err != nil {
			t.Fatalf("asset.upload 应在操作事务内完成，实际失败: %v", outcome.err)
		}
		payload, _ := outcome.result.(map[string]any)
		if payload == nil || payload["assetId"] == "" || payload["resourceId"] == "" {
			t.Fatalf("回执应包含 assetId 与 resourceId: %#v", outcome.result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("asset.upload 超时：上传链路与操作事务在单连接上互相等待（死锁回归）")
	}

	// 素材确实入库且可被 asset.list 查到。
	listed, err := h.run(t, "asset.list", "", map[string]any{"kind": "image"}, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := listed.Result.(map[string]any)
	if raw == nil || raw["total"] != float64(1) {
		t.Fatalf("asset.list 应包含 1 条图片素材: %#v", listed.Result)
	}
	// 文档必须带 id：前端列表页对缺 id 的记录静默隔离，表现为"总量增加但看不到行"。
	if items, _ := raw["items"].([]any); len(items) == 1 {
		item, _ := items[0].(map[string]any)
		if item != nil {
			if id, _ := item["id"].(string); id == "" {
				t.Fatalf("素材文档缺 id，前端会隔离该记录: %#v", item)
			}
		}
	}

	// 同一 operationId 重试幂等：不重复占存储。
	replayed, err := h.run(t, "asset.upload", "upload-op-1", map[string]any{
		"filePath": filePath, "title": "Codex 场景图", "tags": []string{"AI"},
	}, false)
	if err != nil {
		t.Fatalf("同 opID 重试应幂等成功: %v", err)
	}
	again, _ := replayed.Result.(map[string]any)
	if again == nil || again["assetId"] == "" {
		t.Fatalf("重放回执异常: %#v", replayed.Result)
	}
	listed2, err := h.run(t, "asset.list", "", map[string]any{"kind": "image"}, false)
	if err != nil {
		t.Fatal(err)
	}
	raw2, _ := listed2.Result.(map[string]any)
	if raw2 == nil || raw2["total"] != float64(1) {
		t.Fatalf("重试后素材不应重复: %#v", listed2.Result)
	}
}
