package operations

import (
	"encoding/json"
	"io"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

// Domain 是一次操作在当前事务里看到的工作区。方法不接受 *gorm.DB：
// 事务绑定由 DomainBinder 在回执同一条连接上完成。
type Domain interface {
	UserCanvasProject(userID string, id string) (json.RawMessage, error)
	UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (canvas.CanvasLibraryPage, error)
	UserAssetsPage(userID string, page int, pageSize int, filter canvas.UserAssetPageFilter) (canvas.UserAssetPage, error)
	UserAsset(userID string, id string) (json.RawMessage, error)
	UpsertUserAsset(userID string, raw json.RawMessage) (canvas.UserDataSummary, error)
	DeleteUserAsset(userID string, id string, expectedStatus ...string) error
	UploadLocalFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error)
	Task(userID string, id string) (*model.Task, error)
	ResolveAssistantGenerationModel(kind, selectedModel string) (AssistantGenerationModel, error)
	CreateUserCanvasNodes(userID string, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error)
	UpdateUserCanvasNodeFields(userID string, canvasID string, nodeID string, patch map[string]any, expectedRevision int64) (canvas.UserDataSummary, error)
	AppendUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, drafts []canvas.StoryboardRowDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error)
	UpdateUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, patches []canvas.StoryboardRowPatch, expectedRevision int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error)
	RemoveUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, rowIDs []string, expectedRevision int64) (canvas.UserDataSummary, int, error)
	ConnectUserCanvasNodesAtRevision(userID string, canvasID string, fromNodeID string, toNodeID string, expectedRevision int64) (canvas.UserDataSummary, error)
	CommitUserCanvasDocument(userID string, canvasID string, expectedRevision int64, document json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error)
	WorkspaceTask(userID string, id string) (*model.Task, error)
	GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error)
	OwnedReadyResource(userID, resourceID string) (*model.Resource, error)
	OwnedAsset(userID, assetID string) (*model.Asset, error)
	BindExistingCanvasNode(userID string, patch canvas.TaskOutputBind) (canvas.TaskOutputBindResult, error)
	UserConversation(userID, conversationID string) (taskbinding.ConversationView, error)
	AttachConversationMessage(userID string, input taskbinding.MessageAttachInput) (taskbinding.ConversationView, error)
	ListProjectsPage(userID string, page int, pageSize int) (ProjectListPage, error)
	ProjectDetail(userID string, projectID string) (ProjectDetail, error)
	CreateProject(userID string, input ProjectCreateInput) (model.Project, error)
	UpdateProject(userID string, projectID string, input ProjectUpdateInput) (model.Project, error)
	DeleteProject(userID string, projectID string) error
	OwnedProject(userID string, projectID string) (*model.Project, error)
}

// 以下是项目操作的操作层端口类型：project 领域包依赖 operations（章节应用幂等），
// 这里不能反向 import，所以视图与入参由操作层自持，桥接层负责与领域结构互转。

// ProjectSummary 是项目列表卡片：领域聚合的计数并入卡片，调用方一次拿全。
type ProjectSummary struct {
	Project            model.Project `json:"project"`
	CanvasCount        int           `json:"canvasCount"`
	AssetCount         int64         `json:"assetCount"`
	UnitCount          int           `json:"unitCount"`
	CompletedUnitCount int           `json:"completedUnitCount"`
}

type ProjectListPage struct {
	Projects []ProjectSummary `json:"projects"`
	Page     int              `json:"page"`
	PageSize int              `json:"pageSize"`
	Total    int64            `json:"total"`
	HasMore  bool             `json:"hasMore"`
}

// ProjectDetail 是单个项目的结构视图：本体、单元与关联画布。
type ProjectDetail struct {
	Project         model.Project          `json:"project"`
	Units           []model.ProjectUnit    `json:"units"`
	CanvasCounts    map[string]int64       `json:"canvasCounts"`
	Canvases        []model.CanvasProject  `json:"canvases"`
	CanvasUnitLinks []model.CanvasUnitLink `json:"canvasUnitLinks"`
}

// ProjectCreateInput 是创建项目的操作层入参；默认值由领域裁决。
// 带 json tag：create 的 handler 直接把它作为解码目标。
type ProjectCreateInput struct {
	Name              string `json:"name"`
	Type              string `json:"type"`
	AspectRatio       string `json:"aspectRatio"`
	SourceType        string `json:"sourceType"`
	Description       string `json:"description"`
	DefaultImageModel string `json:"defaultImageModel"`
	DefaultVideoModel string `json:"defaultVideoModel"`
}

// ProjectUpdateInput 是局部更新入参：字符串零值表示不改，指针字段可显式清空。
type ProjectUpdateInput struct {
	Name              string
	Type              string
	AspectRatio       string
	SourceType        string
	Status            string
	Description       *string
	DefaultImageModel *string
	DefaultVideoModel *string
}

// AssistantGenerationModel 是一次生成提议解析出的有效模型。
// KindMismatch 表示节点显式模型与本次 kind 冲突，调用方必须拒绝而不是改用默认。
type AssistantGenerationModel struct {
	Display      string
	ModelKey     string
	Revision     int64
	KindMismatch bool
}

// DomainBinder 是组合根把根服务绑到当前事务的唯一缝。操作核的业务端口不再露出 *gorm.DB。
type DomainBinder interface {
	BindDomain(tx *gorm.DB) Domain
}
