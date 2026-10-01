package operations

import (
	"encoding/json"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// Domain 是一次操作在当前事务里看到的工作区。方法不接受 *gorm.DB：
// 事务绑定由 DomainBinder 在回执同一条连接上完成。
type Domain interface {
	UserCanvasProject(userID string, id string) (json.RawMessage, error)
	UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (canvas.CanvasLibraryPage, error)
	UserAssetsPage(userID string, page int, pageSize int, filter canvas.UserAssetPageFilter) (canvas.UserAssetPage, error)
	UserAsset(userID string, id string) (json.RawMessage, error)
	Task(userID string, id string) (*model.Task, error)
	AssistantGenerationModelSnapshot(kind string) (display string, modelKey string, revision int64, err error)
	CreateUserCanvasNodes(userID string, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error)
	UpdateUserCanvasNodeFields(userID string, canvasID string, nodeID string, patch map[string]any, expectedRevision int64) (canvas.UserDataSummary, error)
	ConnectUserCanvasNodesAtRevision(userID string, canvasID string, fromNodeID string, toNodeID string, expectedRevision int64) (canvas.UserDataSummary, error)
	CommitUserCanvasDocument(userID string, canvasID string, expectedRevision int64, document json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error)
	WorkspaceTask(userID string, id string) (*model.Task, error)
	GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error)
	OwnedReadyResource(userID, resourceID string) (*model.Resource, error)
	OwnedAsset(userID, assetID string) (*model.Asset, error)
	BindExistingCanvasNode(userID string, patch canvas.TaskOutputBind) (canvas.TaskOutputBindResult, error)
}

// DomainBinder 是组合根把根服务绑到当前事务的唯一缝。操作核的业务端口不再露出 *gorm.DB。
type DomainBinder interface {
	BindDomain(tx *gorm.DB) Domain
}
