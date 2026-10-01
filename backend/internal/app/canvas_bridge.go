package app

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
)

type (
	AssetsSyncRequest    = canvas.AssetsSyncRequest
	CanvasHistoryList    = canvas.CanvasHistoryList
	UserDataSummary      = canvas.UserDataSummary
	UserDataSnapshot     = canvas.UserDataSnapshot
	CanvasLibrarySummary = canvas.CanvasLibrarySummary
	CanvasLibraryPage    = canvas.CanvasLibraryPage
	UserAssetPage        = canvas.UserAssetPage
	UserAssetPageFilter  = canvas.UserAssetPageFilter
)

type canvasHost struct {
	encryptSecret              func(string) (string, error)
	decryptSecret              func(string) (string, error)
	openResourceRange          func(string, *model.Resource, string) (*assets.ResourceStream, error)
	prepareResourceDelivery    func(string, *model.Resource, assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error)
	withStorageLock            func(func() error) error
	structuredQuota            func(string, string, bool, int64) error
	structuredReplacementQuota func(string, string, int, int64) error
	deleteAsset                func(string, string) error
	recordActivity             func(string, string, int)
}

func (h canvasHost) EncryptSecret(value string) (string, error) {
	if h.encryptSecret == nil {
		return value, nil
	}
	return h.encryptSecret(value)
}

func (h canvasHost) DecryptSecret(value string) (string, error) {
	if h.decryptSecret == nil {
		return value, nil
	}
	return h.decryptSecret(value)
}

func (h canvasHost) OpenResourceRange(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error) {
	if h.openResourceRange == nil {
		return nil, nil
	}
	return h.openResourceRange(userID, resource, rangeHeader)
}

func (h canvasHost) PrepareResourceDelivery(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error) {
	if h.prepareResourceDelivery == nil {
		return nil, nil
	}
	return h.prepareResourceDelivery(userID, resource, options)
}

func (h canvasHost) WithStorageLock(fn func() error) error {
	if h.withStorageLock == nil {
		if fn == nil {
			return nil
		}
		return fn()
	}
	return h.withStorageLock(fn)
}

func (h canvasHost) StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error {
	if h.structuredQuota == nil {
		return nil
	}
	return h.structuredQuota(userID, kind, creating, deltaBytes)
}

func (h canvasHost) StructuredReplacementQuota(userID, kind string, count int, bytes int64) error {
	if h.structuredReplacementQuota == nil {
		return nil
	}
	return h.structuredReplacementQuota(userID, kind, count, bytes)
}

func (h canvasHost) DeleteUserAssetWithResources(userID, assetID string) error {
	if h.deleteAsset == nil {
		return nil
	}
	return h.deleteAsset(userID, assetID)
}

func (h canvasHost) RecordActivity(userID, event string, count int) {
	if h.recordActivity == nil {
		return
	}
	h.recordActivity(userID, event, count)
}

// newCanvasHost 使用根仓储构造 host（常规请求路径）。
func newCanvasHost(service *Service) canvasHost {
	var repo *repository.Repository
	if service != nil {
		repo = service.repo
	}
	return newCanvasHostWithRepo(service, repo)
}

// newCanvasHostWithRepo 与 newCanvasHost 完全一致，但配额/用量读取绑定到给定仓储。
// 事务内的领域写入必须走这里，否则会回到根连接取用量而与自己的事务互相等待。
func newCanvasHostWithRepo(service *Service, repo *repository.Repository) canvasHost {
	if service == nil {
		return canvasHost{}
	}
	return canvasHost{
		encryptSecret: service.encryptSettingSecret, decryptSecret: service.decryptSettingSecret,
		openResourceRange: service.openResourceRange, prepareResourceDelivery: service.prepareResourceDelivery,
		withStorageLock: func(fn func() error) error {
			service.storageMu.Lock()
			defer service.storageMu.Unlock()
			return fn()
		},
		structuredQuota: func(userID, kind string, creating bool, deltaBytes int64) error {
			policy, err := service.RuntimePolicy()
			if err != nil {
				return err
			}
			usage, err := repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredStorageQuotaWithPolicy(usage, kind, creating, deltaBytes, policy.Resource)
		},
		structuredReplacementQuota: func(userID, kind string, count int, bytes int64) error {
			policy, err := service.RuntimePolicy()
			if err != nil {
				return err
			}
			usage, err := repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredReplacementQuotaWithPolicy(usage, kind, count, bytes, policy.Resource)
		},
		deleteAsset: service.deleteUserAssetWithResources, recordActivity: service.recordActivity,
	}
}

func (s *Service) canvasDomain() *canvas.Service {
	if s == nil {
		return canvas.New(nil, nil)
	}
	if s.canvas != nil {
		return s.canvas
	}
	return canvas.New(s.repo, newCanvasHost(s))
}

func (s *Service) validateCanvasMediaAssets(userID string, raw json.RawMessage) error {
	return s.canvasDomain().ValidateCanvasMediaAssets(userID, raw)
}

func (s *Service) validateAssetCanvasReferences(userID string, asset model.Asset) error {
	return s.canvasDomain().ValidateAssetCanvasReferences(userID, asset)
}

func (s *Service) validateAssetReplacementCanvasReferences(userID string, replacement []model.Asset) error {
	return s.canvasDomain().ValidateAssetReplacementCanvasReferences(userID, replacement)
}

func (s *Service) UserDataSnapshot(userID string) (UserDataSnapshot, error) {
	return s.canvasDomain().UserDataSnapshot(userID)
}

func (s *Service) UserAssetSummaries(userID string) ([]UserDataSummary, error) {
	return s.canvasDomain().UserAssetSummaries(userID)
}

func (s *Service) UserAsset(userID string, id string) (json.RawMessage, error) {
	return s.canvasDomain().UserAsset(userID, id)
}

func (s *Service) UpsertUserAsset(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpsertUserAsset(userID, raw)
}

func (s *Service) DeleteUserAsset(userID string, id string) error {
	return s.canvasDomain().DeleteUserAsset(userID, id)
}

func (s *Service) UserAssets(userID string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserAssets(userID)
}

func (s *Service) ReplaceUserAssets(userID string, req AssetsSyncRequest) ([]json.RawMessage, error) {
	return s.canvasDomain().ReplaceUserAssets(userID, req)
}

func (s *Service) UserCanvasProjects(userID string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserCanvasProjects(userID)
}

func (s *Service) UserCanvasProjectSummaries(userID string) ([]UserDataSummary, error) {
	return s.canvasDomain().UserCanvasProjectSummaries(userID)
}

func (s *Service) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	return s.canvasDomain().UserCanvasProject(userID, id)
}

func (s *Service) UpsertUserCanvasProject(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpsertUserCanvasProject(userID, raw)
}

// Database 暴露本进程使用的数据库连接，供操作层与业务写入共用同一事务边界。
func (s *Service) Database() *gorm.DB {
	if s == nil || s.repo == nil {
		return nil
	}
	return s.repo.DB()
}

// canvasDomainWithTx 返回完全绑定到同一事务的画布领域服务：仓储与 host 的配额读取都用同一个连接。
func (s *Service) canvasDomainWithTx(tx *gorm.DB) *canvas.Service {
	repo := s.repo.WithTx(tx)
	return s.canvasDomain().WithRepository(repo).WithHost(newCanvasHostWithRepo(s, repo))
}

// UpsertUserCanvasProjectWithTx 把画布写入放进调用方给出的事务，使操作记录与业务写入原子提交。
func (s *Service) UpsertUserCanvasProjectWithTx(tx *gorm.DB, userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomainWithTx(tx).UpsertUserCanvasProject(userID, raw)
}

func (s *Service) CommitUserCanvasProjectAssets(userID string, raw json.RawMessage, assets []json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().CommitUserCanvasProjectAssets(userID, raw, assets)
}

func (s *Service) DeleteUserCanvasNode(userID, canvasID, nodeID string) (UserDataSummary, error) {
	return s.canvasDomain().DeleteUserCanvasNode(userID, canvasID, nodeID)
}

func (s *Service) UpdateUserCanvasNode(userID, canvasID, nodeID string, patch map[string]json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpdateUserCanvasNode(userID, canvasID, nodeID, patch)
}

func (s *Service) ConnectUserCanvasNodes(userID, canvasID, fromNodeID, toNodeID string, connection map[string]json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().ConnectUserCanvasNodes(userID, canvasID, fromNodeID, toNodeID, connection)
}

func (s *Service) DeleteUserCanvasProject(userID string, id string) error {
	return s.canvasDomain().DeleteUserCanvasProject(userID, id)
}

func (s *Service) CanvasHistory(userID, canvasID string) (CanvasHistoryList, error) {
	return s.canvasDomain().CanvasHistory(userID, canvasID)
}

func (s *Service) CanvasHistorySnapshot(userID, canvasID, snapshotID string) (*model.CanvasSnapshot, error) {
	return s.canvasDomain().CanvasHistorySnapshot(userID, canvasID, snapshotID)
}

func (s *Service) RestoreCanvasHistory(userID, canvasID, snapshotID string, revision *int64) (UserDataSummary, error) {
	return s.canvasDomain().RestoreCanvasHistory(userID, canvasID, snapshotID, revision)
}

func saveCreationCanvasWithHistory(repo *repository.Repository, project *model.CanvasProject, previous string) error {
	before, err := repo.CanvasProjectForUser(project.UserID, project.ID)
	if err != nil {
		return err
	}
	if before.PayloadJSON != previous || before.Revision != project.Revision {
		return repository.ErrCreationConflict
	}
	project.UpdatedAt = time.Now().UTC()
	err = canvas.SaveDocumentWithHistory(repo, before, project, "automatic")
	if errors.Is(err, repository.ErrCanvasRevisionConflict) {
		return repository.ErrCreationConflict
	}
	return err
}

func (s *Service) UserAssetsByIDs(userID string, ids []string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserAssetsByIDs(userID, ids)
}

func (s *Service) UserAssetsPage(userID string, page int, pageSize int, filter UserAssetPageFilter) (UserAssetPage, error) {
	return s.canvasDomain().UserAssetsPage(userID, page, pageSize, filter)
}

func (s *Service) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (CanvasLibraryPage, error) {
	return s.canvasDomain().UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
}

func clientAssetPayload(asset model.Asset) json.RawMessage {
	return canvas.ClientAssetPayload(asset)
}

func validateSyncedPayload(raw json.RawMessage, label string) error {
	return canvas.ValidateSyncedPayload(raw, label)
}

func containsInlineMediaDataURL(value interface{}) bool {
	return canvas.ContainsInlineMediaDataURL(value)
}

func assetFromJSON(userID string, raw json.RawMessage) (model.Asset, error) {
	return canvas.AssetFromJSON(userID, raw)
}

// DataDir 返回本进程的数据目录，供操作层的本机客户端登记等本地状态使用。
func (s *Service) DataDir() string {
	if s == nil {
		return ""
	}
	return s.dataDir
}

// UserCanvasProjectWithTx 在调用方事务里读取画布，让操作层读写共用同一条连接。
func (s *Service) UserCanvasProjectWithTx(tx *gorm.DB, userID string, id string) (json.RawMessage, error) {
	return s.canvasDomainWithTx(tx).UserCanvasProject(userID, id)
}

// UserAssetWithTx 在调用方事务里读取素材，与写操作同事务。
func (s *Service) UserAssetWithTx(tx *gorm.DB, userID string, id string) (json.RawMessage, error) {
	return s.canvasDomainWithTx(tx).UserAsset(userID, id)
}

// 以下是内置 Agent/CLI/MCP 的统一写入口：领域实现拥有规格与连接规则，
// 操作层只做参数与幂等，写入与操作记录共用同一事务（tx 绑定仓储与 host）。
func (s *Service) CreateUserCanvasNodesWithTx(tx *gorm.DB, userID, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (UserDataSummary, []canvas.CreatedNode, error) {
	return s.canvasDomainWithTx(tx).CreateUserCanvasNodes(userID, canvasID, drafts, expectedRevision)
}

func (s *Service) UpdateUserCanvasNodeFieldsWithTx(tx *gorm.DB, userID, canvasID, nodeID string, patch map[string]any, expectedRevision int64) (UserDataSummary, error) {
	return s.canvasDomainWithTx(tx).UpdateUserCanvasNodeFields(userID, canvasID, nodeID, patch, expectedRevision)
}

func (s *Service) ConnectUserCanvasNodesWithTx(tx *gorm.DB, userID, canvasID, fromNodeID, toNodeID string, expectedRevision int64) (UserDataSummary, error) {
	return s.canvasDomainWithTx(tx).ConnectUserCanvasNodesAtRevision(userID, canvasID, fromNodeID, toNodeID, expectedRevision)
}

// BindDomain 把当前事务绑成操作层 Domain：画布读写走同一条连接，任务/模型快照仍由组合根提供。
func (s *Service) BindDomain(tx *gorm.DB) operations.Domain {
	if tx == nil {
		return &operationSession{canvas: s.canvasDomain(), service: s}
	}
	return &operationSession{canvas: s.canvasDomainWithTx(tx), service: s}
}

type operationSession struct {
	canvas  *canvas.Service
	service *Service
}

func (s *operationSession) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	return s.canvas.UserCanvasProject(userID, id)
}

func (s *operationSession) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (canvas.CanvasLibraryPage, error) {
	return s.canvas.UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
}

func (s *operationSession) UserAssetsPage(userID string, page int, pageSize int, filter canvas.UserAssetPageFilter) (canvas.UserAssetPage, error) {
	return s.canvas.UserAssetsPage(userID, page, pageSize, filter)
}

func (s *operationSession) UserAsset(userID string, id string) (json.RawMessage, error) {
	return s.canvas.UserAsset(userID, id)
}

func (s *operationSession) Task(userID string, id string) (*model.Task, error) {
	return s.service.Task(userID, id)
}

func (s *operationSession) AssistantGenerationModelSnapshot(kind string) (string, string, int64, error) {
	return s.service.AssistantGenerationModelSnapshot(kind)
}

func (s *operationSession) CreateUserCanvasNodes(userID string, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error) {
	return s.canvas.CreateUserCanvasNodes(userID, canvasID, drafts, expectedRevision)
}

func (s *operationSession) UpdateUserCanvasNodeFields(userID string, canvasID string, nodeID string, patch map[string]any, expectedRevision int64) (canvas.UserDataSummary, error) {
	return s.canvas.UpdateUserCanvasNodeFields(userID, canvasID, nodeID, patch, expectedRevision)
}

func (s *operationSession) ConnectUserCanvasNodesAtRevision(userID string, canvasID string, fromNodeID string, toNodeID string, expectedRevision int64) (canvas.UserDataSummary, error) {
	return s.canvas.ConnectUserCanvasNodesAtRevision(userID, canvasID, fromNodeID, toNodeID, expectedRevision)
}

func (s *operationSession) CommitUserCanvasDocument(userID string, canvasID string, expectedRevision int64, document json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) {
	return s.canvas.CommitUserCanvasDocument(userID, canvasID, expectedRevision, document)
}

var (
	_ operations.DomainBinder = (*Service)(nil)
	_ operations.Domain       = (*operationSession)(nil)
)
