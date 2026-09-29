package agentops_test

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// 自包含集成回归：真实临时 SQLite + 真实领域写入，验证事务/幂等/CAS/能力边界。
// 不依赖任何外部脚本或已运行的服务，正常 go test 即可验证核心。
type harness struct {
	registry *agentops.Registry
	userID   string
	canvasID string
	revision int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "agentops.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("打开临时库失败: %v", err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatalf("迁移失败: %v", err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatalf("创建工作区失败: %v", err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	registry := agentops.NewRegistry(service, agentops.NewStore(db))
	agentops.RegisterDefaultOps(registry)

	canvasID := "integration-canvas"
	doc := map[string]any{
		"id": canvasID, "title": "集成回归画布", "revision": 0,
		"nodes": []any{
			map[string]any{"id": "n1", "type": "image", "title": "原镜头1", "position": map[string]any{"x": 1, "y": 1},
				"width": 320, "height": 220, "metadata": map[string]any{"prompt": "原始1", "tag": "keep"}},
			map[string]any{"id": "n2", "type": "image", "title": "原镜头2", "position": map[string]any{"x": 2, "y": 2},
				"width": 320, "height": 220, "metadata": map[string]any{"prompt": "原始2", "tag": "keep"}},
		},
		"connections": []any{map[string]any{"id": "e1", "fromNodeId": "n1", "toNodeId": "n2"}},
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("序列化画布失败: %v", err)
	}
	if _, err := service.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatalf("写入初始画布失败: %v", err)
	}
	raw, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatalf("读取初始画布失败: %v", err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("解析初始画布失败: %v", err)
	}
	revision := int64(stored["revision"].(float64))
	return &harness{registry: registry, userID: "local", canvasID: canvasID, revision: revision}
}

func (h *harness) run(t *testing.T, op, opID string, params map[string]any, readOnly bool) (agentops.Result, error) {
	t.Helper()
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("序列化参数失败: %v", err)
	}
	return h.registry.Execute(agentops.Request{Op: op, OpID: opID, UserID: h.userID, ReadOnly: readOnly, Params: encoded})
}

func (h *harness) canvas(t *testing.T) map[string]any {
	t.Helper()
	result, err := h.run(t, "canvas.get", "", map[string]any{"canvasId": h.canvasID}, false)
	if err != nil {
		t.Fatalf("读取画布失败: %v", err)
	}
	payload := result.Result.(map[string]any)
	return payload["canvas"].(map[string]any)
}

func opCode(t *testing.T, err error) agentops.Code {
	t.Helper()
	var opErr *agentops.Error
	if !errors.As(err, &opErr) {
		t.Fatalf("期望结构化操作错误，得到 %v", err)
	}
	return opErr.Code
}

func TestWriteRequiresOperationIDAndRevision(t *testing.T) {
	h := newHarness(t)
	_, err := h.run(t, "canvas.nodes.create", "", map[string]any{"canvasId": h.canvasID,
		"expectedRevision": h.revision, "nodes": []any{map[string]any{"title": "A", "type": "image"}}}, false)
	if code := opCode(t, err); code != agentops.CodeInvalidArgument {
		t.Fatalf("缺少 opId 应被拒，得到 %v", code)
	}
	_, err = h.run(t, "canvas.node.update", "op-no-rev", map[string]any{"canvasId": h.canvasID,
		"nodeId": "n1", "patch": map[string]any{"prompt": "x"}}, false)
	if code := opCode(t, err); code != agentops.CodeInvalidArgument {
		t.Fatalf("缺少 expectedRevision 应被拒，得到 %v", code)
	}
}

func TestIdempotentReplayAndConflict(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "镜头A", "type": "image"}, map[string]any{"title": "镜头B", "type": "image"}}}
	first, err := h.run(t, "canvas.nodes.create", "op-create", params, false)
	if err != nil {
		t.Fatalf("首次创建失败: %v", err)
	}
	if first.Replayed {
		t.Fatal("首次执行不应标记为回放")
	}
	second, err := h.run(t, "canvas.nodes.create", "op-create", params, false)
	if err != nil {
		t.Fatalf("重试应回读原结果，得到错误: %v", err)
	}
	if !second.Replayed {
		t.Fatal("同 opId 同 payload 必须回读原结果")
	}
	firstJSON, _ := json.Marshal(first.Result)
	secondJSON, _ := json.Marshal(second.Result)
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("回放结果应与首次一致:\n%s\n%s", firstJSON, secondJSON)
	}
	conflictParams := map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "别的", "type": "image"}}}
	_, err = h.run(t, "canvas.nodes.create", "op-create", conflictParams, false)
	if code := opCode(t, err); code != agentops.CodeConflict {
		t.Fatalf("同 opId 不同 payload 应为冲突，得到 %v", code)
	}
}

func TestLocalUpdateKeepsNonTargetDataAndBlocksStaleRevision(t *testing.T) {
	h := newHarness(t)
	before := h.canvas(t)
	beforeNodes := before["nodes"].([]any)
	beforeOther := mustJSON(t, beforeNodes[1])
	beforeConnections := mustJSON(t, before["connections"])

	if _, err := h.run(t, "canvas.node.update", "op-update", map[string]any{"canvasId": h.canvasID,
		"nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"prompt": "改成夜景"}}, false); err != nil {
		t.Fatalf("局部修改失败: %v", err)
	}
	after := h.canvas(t)
	afterNodes := after["nodes"].([]any)
	target := afterNodes[0].(map[string]any)
	metadata := target["metadata"].(map[string]any)
	if metadata["prompt"] != "改成夜景" {
		t.Fatalf("目标字段未写入: %v", metadata["prompt"])
	}
	if metadata["tag"] != "keep" {
		t.Fatalf("非目标字段被破坏: %v", metadata)
	}
	if mustJSON(t, afterNodes[1]) != beforeOther {
		t.Fatal("非目标节点被改动")
	}
	if mustJSON(t, after["connections"]) != beforeConnections {
		t.Fatal("连线被改动")
	}

	// 陈旧 revision：必须停写，且画布保持上一次成功写入的内容
	_, err := h.run(t, "canvas.node.update", "op-stale", map[string]any{"canvasId": h.canvasID,
		"nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"prompt": "不应写入"}}, false)
	if code := opCode(t, err); code != agentops.CodePreconditionFailed {
		t.Fatalf("陈旧 revision 应为前置条件失败，得到 %v", code)
	}
	final := h.canvas(t)
	finalPrompt := final["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["prompt"]
	if finalPrompt != "改成夜景" {
		t.Fatalf("陈旧写入不应覆盖，得到 %v", finalPrompt)
	}
}

func TestReadOnlyClientCannotWriteAndCapabilityListIsFiltered(t *testing.T) {
	h := newHarness(t)
	_, err := h.run(t, "canvas.nodes.create", "op-ro", map[string]any{"canvasId": h.canvasID,
		"expectedRevision": h.revision, "nodes": []any{map[string]any{"title": "X", "type": "image"}}}, true)
	if code := opCode(t, err); code != agentops.CodeReadOnly {
		t.Fatalf("只读客户端写操作应被拒，得到 %v", code)
	}
	readOnly := h.registry.List(true)
	for _, descriptor := range readOnly {
		if !descriptor.ReadOnly {
			t.Fatalf("只读能力列表混入写操作: %s", descriptor.ID)
		}
	}
	if len(readOnly) != 5 {
		t.Fatalf("只读操作应为 5 个，得到 %d", len(readOnly))
	}
	if _, err := h.run(t, "canvas.get", "", map[string]any{"canvasId": h.canvasID}, true); err != nil {
		t.Fatalf("只读客户端读操作应可用: %v", err)
	}
}

func TestWriteOperationsExposeStableOperationIDInSchema(t *testing.T) {
	h := newHarness(t)
	for _, descriptor := range h.registry.List(false) {
		if descriptor.ReadOnly {
			continue
		}
		if !contains(string(descriptor.Params), "operationId") {
			t.Fatalf("写操作 schema 未暴露 operationId: %s", descriptor.ID)
		}
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	return string(encoded)
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
