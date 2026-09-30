package agentops

import (
	"encoding/json"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
)

// 操作层只依赖下面这些窄端口，而不是整个 app.Service：
// 每个端口就是一组操作真正用到的方法，替换实现或写 fake 都不需要拼装巨型服务。
// 组合根（app.Service）在结构上满足它们，不需要额外的适配层。
type (
	// CanvasPort 是画布读取能力。
	CanvasPort interface {
		UserCanvasProject(userID string, id string) (json.RawMessage, error)
		UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (canvas.CanvasLibraryPage, error)
		UserCanvasProjectWithTx(tx *gorm.DB, userID string, id string) (json.RawMessage, error)
	}
	// CanvasWritePort 是画布写入能力；实现必须在给定事务里落库。
	CanvasWritePort interface {
		CreateUserCanvasNodesWithTx(tx *gorm.DB, userID string, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error)
		UpdateUserCanvasNodeFieldsWithTx(tx *gorm.DB, userID string, canvasID string, nodeID string, patch map[string]any, expectedRevision int64) (canvas.UserDataSummary, error)
		ConnectUserCanvasNodesWithTx(tx *gorm.DB, userID string, canvasID string, fromNodeID string, toNodeID string, expectedRevision int64) (canvas.UserDataSummary, error)
	}
	// AssetPort 是素材读取能力。
	AssetPort interface {
		UserAssetsPage(userID string, page int, pageSize int, filter app.UserAssetPageFilter) (app.UserAssetPage, error)
		UserAssetWithTx(tx *gorm.DB, userID string, id string) (json.RawMessage, error)
	}
	// TaskPort 是任务状态读取能力。
	TaskPort interface {
		Task(userID string, id string) (*model.Task, error)
	}
	// GenerationPort 是付费生成提议需要的模型快照。
	GenerationPort interface {
		AssistantGenerationModelSnapshot(kind string) (display string, modelKey string, revision int64, err error)
	}
)

// Services 是全部窄端口的组合；操作注册表只要求这个组合。
type Services interface {
	CanvasPort
	CanvasWritePort
	AssetPort
	TaskPort
	GenerationPort
}
