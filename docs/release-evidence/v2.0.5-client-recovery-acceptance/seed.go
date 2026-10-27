// 仅生成隔离验收数据；复制到 backend/cmd/v205-client-fixture/main.go 后运行。
// 不启动服务或恢复，不写成功状态；随后由未经修改的桌面客户端完成恢复。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	dir, upstream := os.Args[1], os.Args[2]
	must(os.MkdirAll(dir, 0700))
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "open_ai_canvas.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	must(err)
	must(database.MigrateLocalSchema(db))
	repo := repository.New(db)
	workspace, err := repo.DefaultWorkspace()
	must(err)
	ownerID := workspace.ID
	s := app.NewLocal(repo, dir)
	task := model.Task{ID: "v205-client-image", UserID: ownerID, ProjectID: "v205-client-canvas", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", Error: "context deadline exceeded", RouteRun: 3, InputJSON: `{"mode":"image","metadata":{"source":"canvas","nodeId":"n1"}}`}
	doc, err := json.Marshal(map[string]any{"id": task.ProjectID, "title": "完整客户端免费恢复验收", "revision": 0, "nodes": []any{map[string]any{"id": "n1", "type": "image", "title": "历史图片恢复", "width": 320, "height": 200, "position": map[string]any{"x": 0, "y": 0}, "metadata": map[string]any{"taskId": task.ID, "status": "error", "error": task.Error, "generationSubmissionState": "unknown"}}}, "connections": []any{}})
	must(err)
	_, err = s.UpsertUserCanvasProject(ownerID, doc)
	must(err)
	must(db.Create(&task).Error)
	receipt := model.ApiCallLog{ID: "v205-client-receipt", UserID: ownerID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: fmt.Sprintf(`{"data":[{"url":%q}]}`, upstream+"/original.png")}
	must(db.Create(&receipt).Error)
	current, err := s.Task(ownerID, task.ID)
	must(err)
	if current.Outcome == nil || current.Outcome.Phase != "retrievable" {
		panic("初始任务不可取回")
	}
	raw, err := s.UserCanvasProject(ownerID, task.ProjectID)
	must(err)
	out, err := json.MarshalIndent(map[string]any{"task": current, "routeRun": 3, "canvas": json.RawMessage(raw)}, "", "  ")
	must(err)
	fmt.Println(string(out))
	sqlDB, err := db.DB()
	must(err)
	must(sqlDB.Close())
}
