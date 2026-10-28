package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/appearance"
	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/playback"
	"infinite-canvas/backend/internal/plugins"
	localproject "infinite-canvas/backend/internal/project"
	"infinite-canvas/backend/internal/prompts"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"
	"infinite-canvas/backend/internal/supporttrace"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskdelivery"
	"infinite-canvas/backend/internal/textreplay"
)

type Service struct {
	canvasWorkflowMu         sync.Mutex
	canvasWorkflowLoop       bool
	repo                     *repository.Repository
	dataDir                  string
	mode                     serviceMode
	cancelMu                 sync.Mutex
	storageMu                sync.Mutex
	workerRuntimeMu          sync.Mutex
	characterTaskMu          sync.Mutex
	activeCancels            map[string]context.CancelFunc
	pendingStorage           map[string]int64
	coordinator              *platform.Coordinator
	platform                 *platform.Service
	taskTerminalCoordinator  *taskTerminalCoordinator
	taskRouteExecutor        *taskRouteExecutor
	taskWorkerCoordinator    *taskWorkerCoordinator
	taskLifecycleCoordinator *taskLifecycleCoordinator
	runtimeErr               error
	localResourceStorage     bool
	pluginRuntime            *pluginRuntime
	pluginRuntimeErr         error
	workerID                 string
	routerMu                 sync.Mutex
	router                   *modelcatalog.Router
	routeCatalogTTL          time.Duration
	routeCatalogMaxStale     time.Duration
	workers                  *platform.Worker
	readCachesOnce           sync.Once
	concurrencyReadCache     *platform.BoundedReadCache[string, platform.RuntimeTaskPolicy]
	textReplay               *textreplay.Service
	textReplayOnce           sync.Once
	routeVersionReadCache    *platform.BoundedReadCache[string, int64]
	skills                   *skills.Service
	prompts                  *prompts.Service
	projects                 *localproject.Service
	canvas                   *canvas.Service
	assistantTurns           *assistantturns.Service
	continuationBackground   assistantContinuationBackground
	assets                   *localasset.Service
	assetsOnce               sync.Once
	appearance               *appearance.Service
	appearanceOnce           sync.Once
	diagnostics              *diagnostics.Service
	diagnosticsOnce          sync.Once
	supportTraceOnce         sync.Once
	supportTraceRecorder     *supporttrace.Recorder
	supportTraceErr          error
	supportTraceClosed       atomic.Bool
	playback                 *playback.Service
	playbackOnce             sync.Once
	depthCapture             *depthcapture.Service
	depthCaptureOnce         sync.Once
	beefAPI                  *beefapi.Service
	generationDeliveryMedia  taskdelivery.Media
	generationDelivery       *taskdelivery.Deliverer
	deliveryMu               sync.Mutex
	deliveryProgress         *deliveryProgressRegistry
	deliveryProgressOnce     sync.Once
	referenceProgress        sync.Map
	deliveryControlMu        sync.Mutex
	deliveryCancels          map[string]context.CancelFunc
	deliveryDeadlines        map[string]time.Time
	deliveryClosed           bool
	tasks                    *localtask.Service
	tasksOnce                sync.Once
	workspaceOps             *operations.Registry
	workspaceOpsMu           sync.Mutex
	imageRecoveryActive      atomic.Bool
	imageRecoveryAfterID     string
	providerRecoveryAfterID  string
	bindAfterID              string
	bindCursorMu             sync.Mutex
}

const taskWorkerConcurrency = 3
const taskLogPayloadLimit = 4000

type CreateTaskRequest struct {
	ProjectID      string         `json:"projectId"`
	Type           string         `json:"type"`
	Operation      string         `json:"operation"`
	Prompt         string         `json:"prompt"`
	Provider       string         `json:"provider"`
	Model          string         `json:"model"`
	LogicalModelID string         `json:"logicalModelId"`
	Input          map[string]any `json:"input"`
	TraceID        string         `json:"-"`
	RequestID      string         `json:"-"`
}

type TaskListOptions = localtask.ListOptions

func New(repo *repository.Repository, dataDir string) *Service {
	return newService(repo, dataDir, serviceOptions{mode: serviceModeHosted})
}

// NewLocal is the desktop constructor. It keeps local protocol plugins
// available for generation workflows.
func NewLocal(repo *repository.Repository, dataDir string) *Service {
	return newService(repo, dataDir, serviceOptions{mode: serviceModeLocal})
}

// IsLocalMode is the canonical runtime-profile check for service-layer code.
// Storage behavior is derived from the profile, but callers should use this
// method instead of inferring the runtime mode from a storage detail.
func (s *Service) IsLocalMode() bool {
	return s != nil && s.mode == serviceModeLocal
}

// serviceOptions makes the runtime profile explicit at the construction
// boundary. Capabilities are derived from the profile so callers cannot mix
// local and hosted storage behavior accidentally.
type serviceMode string

const (
	serviceModeHosted serviceMode = "hosted"
	serviceModeLocal  serviceMode = "local"
)

type serviceOptions struct {
	mode serviceMode
}

func newService(repo *repository.Repository, dataDir string, options serviceOptions) *Service {
	localResourceStorage := options.mode == serviceModeLocal
	coordinator := platform.NewLocalCoordinator()
	var pluginRuntime *pluginRuntime
	var pluginRuntimeErr error
	if repo == nil {
		pluginRuntimeErr = fmt.Errorf("插件状态存储未初始化")
	} else {
		pluginRuntime, pluginRuntimeErr = newPluginRuntimeWithReferences(dataDir, plugins.NewRepositoryStore(repo), newPluginReferences(dataDir, repo))
	}
	service := &Service{repo: repo, dataDir: dataDir, mode: options.mode, activeCancels: make(map[string]context.CancelFunc), coordinator: coordinator, localResourceStorage: localResourceStorage, pluginRuntime: pluginRuntime, pluginRuntimeErr: pluginRuntimeErr, workerID: newID(), routeCatalogTTL: 30 * time.Second, routeCatalogMaxStale: 5 * time.Minute}
	service.taskTerminalCoordinator = newTaskTerminalCoordinator(service)
	service.taskRouteExecutor = newTaskRouteExecutor(service)
	service.taskWorkerCoordinator = newTaskWorkerCoordinator(service)
	service.taskLifecycleCoordinator = newTaskLifecycleCoordinator(service)
	service.skills = skills.New(service.repo, service.dataDir, service.runWorkerLoop)
	service.prompts = prompts.New(service.repo, newPromptAdminGate(service))
	service.projects = localproject.New(repo, localproject.Dependencies{})
	service.canvas = canvas.New(service.repo, newCanvasHost(service))
	service.assistantTurns = assistantturns.New(assistantturns.NewStore(service.repo), assistantCanvasFactory{service}, filepath.Join(dataDir, "assistant-turns"))
	service.assets = localasset.NewService(localasset.Dependencies{
		DataDir:      dataDir,
		Repository:   localasset.NewRepository(repo),
		Blobs:        localasset.NewFileStore(dataDir),
		Quota:        resourceQuota{svc: service},
		Lifecycle:    resourceLifecycle{svc: service},
		LocalStorage: localResourceStorage,
	})
	service.tasks = localtask.NewService(localtask.NewStore(service.repo), service.taskDependencies())
	if service.IsLocalMode() {
		service.platform = platform.NewLocal(service.repo, coordinator, newPlatformHost(service))
	} else {
		service.platform = platform.New(service.repo, coordinator, newPlatformHost(service))
	}
	service.ensureRouter()
	return service
}

func (s *Service) StartWorker() {
	s.deliveryControlMu.Lock()
	runtime := s.backgroundWorkers()
	ctx, started := runtime.Start()
	if started {
		s.deliveryClosed = false
	}
	s.deliveryControlMu.Unlock()
	if !started {
		return
	}
	s.taskWorker().start(ctx)
	s.startResourceDeletionWorker(ctx)
}

func (s *Service) BeginDrain() { s.stopGenerationDownloads(); s.backgroundWorkers().BeginDrain() }

func (s *Service) StopWorker(ctx context.Context) error {
	s.stopGenerationDownloads()
	return s.backgroundWorkers().Stop(ctx)
}

func (s *Service) IsDraining() bool { return s.backgroundWorkers().IsDraining() }

func (s *Service) ActiveWorkerTasks() int64 { return s.backgroundWorkers().ActiveTaskCount() }

func (s *Service) backgroundWorkers() *platform.Worker {
	s.workerRuntimeMu.Lock()
	defer s.workerRuntimeMu.Unlock()
	if s.workers == nil {
		s.workers = &platform.Worker{}
	}
	return s.workers
}

func (s *Service) runWorkerLoop(fn func(context.Context)) bool {
	return s.backgroundWorkers().GoLoop(fn)
}

func (s *Service) runWorkerTask(fn func()) bool {
	return s.backgroundWorkers().GoTask(fn)
}

func (s *Service) Tasks(userID string, limit int) ([]TaskSummary, error) {
	return s.TasksWithOptions(userID, TaskListOptions{Limit: limit})
}

func (s *Service) TasksWithOptions(userID string, options TaskListOptions) ([]TaskSummary, error) {
	return s.taskDomain().TasksWithOptions(userID, options)
}

func (s *Service) Task(userID string, id string) (*model.Task, error) {
	return s.taskDomain().Get(userID, id)
}

func (s *Service) TaskByClientOperation(userID, projectID, operationID string) (*model.Task, error) {
	return s.taskDomain().FindOperation(userID, projectID, operationID)
}

func (s *Service) hydrateTaskProviderRequestID(task *model.Task) {
	if task == nil || task.ProviderRequestID != "" {
		return
	}
	if task.ProviderRequestID == "" {
		if providerRequestID, err := s.repo.LatestProviderRequestIDForTask(task.ID); err == nil {
			task.ProviderRequestID = providerRequestID
		}
	}
}

// 上游请求日志会在任务执行期间更新 provider 状态，终态保存前必须重新合并，避免旧任务对象覆盖可恢复 ID。
func (s *Service) refreshTaskProviderState(task *model.Task) error {
	if task == nil || task.ID == "" {
		return errors.New("任务状态无效")
	}
	latest, err := s.repo.Task(task.ID)
	if err != nil {
		return fmt.Errorf("刷新任务上游状态失败：%w", err)
	}
	if latest.ProviderRequestID != "" {
		task.ProviderRequestID = latest.ProviderRequestID
	}
	task.Stage, task.Progress = latest.Stage, latest.Progress
	task.PollStage = latest.PollStage
	task.NextPollAt = latest.NextPollAt
	task.ProviderCancelStatus = latest.ProviderCancelStatus
	task.ProviderCancelError = latest.ProviderCancelError
	task.ProviderCancelAttempts = latest.ProviderCancelAttempts
	task.ProviderCancelRequestedAt = latest.ProviderCancelRequestedAt
	task.ProviderCancelledAt = latest.ProviderCancelledAt
	task.ProviderCancelNextCheckAt = latest.ProviderCancelNextCheckAt
	return nil
}

func (s *Service) RetryTask(userID string, id string) (*model.Task, error) {
	return s.retryTask(userID, id, "")
}

func (s *Service) RetryTaskWithOperation(userID, id, clientOperationID string) (*model.Task, error) {
	return s.retryTask(userID, id, clientOperationID)
}

func (s *Service) retryTask(userID, id, clientOperationID string) (result *model.Task, err error) {
	operationID := strings.TrimSpace(clientOperationID)
	if s.repo == nil || (operationID == "" && s.IsDraining()) {
		return s.taskDomain().Retry(userID, id)
	}
	defer func() {
		// Another request may commit between the initial lookup and a domain
		// eligibility read. Resolve that admission rather than returning a
		// spurious "only failed tasks" error to the concurrent replay.
		if err != nil && operationID != "" {
			if replayed, found, lookupErr := s.repo.RetryOperationForTask(userID, operationID, id); lookupErr == nil && found {
				s.attachTaskDelivery(replayed)
				result = taskForOutput(*replayed)
				err = nil
				return
			}
		}
		switch {
		case errors.Is(err, repository.ErrRetryOperationConflict):
			err = kernel.NewAppError(kernel.CodeConflict, "此操作编号已用于其他重试，请使用新的操作编号")
		case errors.Is(err, repository.ErrRetryOperationInProgress), errors.Is(err, repository.ErrTaskStateConflict), errors.Is(err, repository.ErrTaskProviderRecoveryConflict):
			err = kernel.NewAppError(kernel.CodeConflict, "任务正在处理中，请稍后重试")
		}
	}()
	if operationID != "" {
		replayed, found, lookupErr := s.repo.RetryOperationForTask(userID, operationID, id)
		if lookupErr != nil && !errors.Is(lookupErr, repository.ErrRetryOperationInProgress) {
			return nil, lookupErr
		}
		if found {
			s.attachTaskDelivery(replayed)
			return taskForOutput(*replayed), nil
		}
	}
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]any{"taskId": id, "routeRun": task.RouteRun, "action": "retry"})
	payloadHash := operations.PayloadHash("task.retry", operations.CanonicalJSON(payload))
	if s.IsDraining() {
		return s.taskDomain().Retry(userID, id)
	}
	if s.freeRetryPath(*task) {
		if operationID != "" {
			// Pause removal and admission are one short transaction. Even an
			// exit before the first GET leaves a task the existing worker resumes.
			admitted, accepted, admitErr := s.admitFreeRetry(userID, operationID, payloadHash, *task)
			if admitErr != nil {
				return nil, admitErr
			}
			if accepted && task.Status == model.TaskStatusFailed {
				_, _, _ = s.recoverOriginalTask(context.Background(), *task)
			}
			current, readErr := s.Task(userID, id)
			if readErr != nil {
				return nil, readErr
			}
			current.RetryOperation = admitted.RetryOperation
			return current, nil
		}
		if recovered, handled, recoverErr := s.recoverOriginalTask(context.Background(), *task); handled {
			return recovered, recoverErr
		}
	}
	if operationID != "" {
		return s.taskDomain().RetryWithOperation(userID, id, operationID, payloadHash)
	}
	return s.taskDomain().Retry(userID, id)
}

func (s *Service) recoverOriginalTask(ctx context.Context, task model.Task) (*model.Task, bool, error) {
	if task.Status == model.TaskStatusSucceeded && deliveryPaused(task.Stage) {
		result, err := s.resumeGenerationDownload(task)
		return result, true, err
	}
	if task.Status == model.TaskStatusFailed && task.ProviderRequestID != "" && (strings.HasPrefix(task.Type, "canvas_video") || strings.HasPrefix(task.Type, "video_") || generation.UpscaleMediaType(task.Model) != "") {
		result, err := s.queryFailedVideoTask(ctx, &task, task.UserID)
		if err != nil {
			return nil, true, err
		}
		return result.Task, true, nil
	}
	return s.recoverAcceptedImageContext(ctx, task)
}

func (s *Service) freeRetryPath(task model.Task) bool {
	if task.Status == model.TaskStatusSucceeded && deliveryPaused(task.Stage) {
		return true
	}
	if task.Status == model.TaskStatusFailed && task.Stage != "submission_unknown" && task.ProviderRequestID != "" && (task.RecoveryOutcome == nil || *task.RecoveryOutcome == "") && (strings.HasPrefix(task.Type, "canvas_video") || strings.HasPrefix(task.Type, "video_") || generation.UpscaleMediaType(task.Model) != "") {
		return true
	}
	if task.Type != "canvas_image" || task.Status != model.TaskStatusFailed {
		return false
	}
	if s.imageRecoveryAllowsRetry(task) {
		return false
	}
	receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
	if err != nil {
		return true
	}
	if receipt != nil && receipt.StatusCode < 300 {
		return true
	}
	// An accepted BeefAPI image may only expose an asynchronous job ID in its
	// creation response. Presence of that ID is enough to keep /retry on the
	// query-only recovery path; imageJobResult performs the actual GET later.
	jobID, err := s.repo.LatestBeefAPIImageJobIDForTask(task)
	return err == nil && strings.TrimSpace(jobID) != ""
}

func (s *Service) CancelTask(ctx context.Context, userID string, id string) (*model.Task, error) {
	if task, err := s.repo.TaskForUser(userID, id); err == nil && task.Status == model.TaskStatusSucceeded {
		return s.pauseGenerationDownload(*task, "delivery_paused")
	}
	return s.taskDomain().Cancel(ctx, userID, id)
}

func (s *Service) TaskLogs(userID string, id string) ([]model.TaskLog, error) {
	return s.taskDomain().Logs(userID, id)
}

func (s *Service) ProcessNextTask() error {
	return s.taskWorker().processNextTask()
}

func shotIDs(prefix string, count int) []string {
	ids := make([]string, 0, count)
	for index := 0; index < count; index++ {
		ids = append(ids, fmt.Sprintf("%s-shot-%d", prefix, index+1))
	}
	return ids
}

func stringSlice(value any) []string {
	items, ok := value.([]interface{})
	if !ok {
		text := stringValue(value)
		if text == "" {
			return nil
		}
		return []string{text}
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(fmt.Sprint(item)); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func stringValue(value any) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}

func (s *Service) log(userID string, taskID string, level string, message string, payload string) error {
	traceID := ""
	requestID := ""
	if taskID != "" {
		if task, err := s.repo.Task(taskID); err == nil {
			traceID = task.TraceID
			requestID = task.RequestID
		}
	}
	return s.repo.Create(&model.TaskLog{ID: newID(), UserID: userID, TaskID: taskID, TraceID: traceID, RequestID: requestID, Level: level, Message: message, Payload: truncateTaskLogPayload(payload)})
}

func truncateTaskLogPayload(payload string) string {
	if len(payload) <= taskLogPayloadLimit {
		return payload
	}
	end := taskLogPayloadLimit
	for end > 0 && !utf8.ValidString(payload[:end]) {
		end--
	}
	return payload[:end] + fmt.Sprintf("\n...（日志内容已截断，原始长度 %d 字符）", len(payload))
}

func (s *Service) registerActiveTask(id string, cancel context.CancelFunc) {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	if s.activeCancels == nil {
		s.activeCancels = make(map[string]context.CancelFunc)
	}
	s.activeCancels[id] = cancel
}

func (s *Service) unregisterActiveTask(id string) {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	delete(s.activeCancels, id)
}

func (s *Service) cancelActiveTask(id string) {
	s.cancelMu.Lock()
	cancel := s.activeCancels[id]
	s.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.deliveryControlMu.Lock()
	for identity, stop := range s.deliveryCancels {
		if strings.HasPrefix(identity, id+":") {
			stop()
		}
	}
	s.deliveryControlMu.Unlock()
}

func nodeOp(id string, nodeType string, title string, x int, y int, workflowKind string, content string) map[string]any {
	return nodeOpWithMetadata(id, nodeType, title, x, y, map[string]any{"content": content, "workflowKind": workflowKind, "status": "idle"})
}

func nodeOpWithMetadata(id string, nodeType string, title string, x int, y int, metadata map[string]any) map[string]any {
	return map[string]any{
		"type":     "add_node",
		"id":       id,
		"nodeType": nodeType,
		"title":    title,
		"position": map[string]int{"x": x, "y": y},
		"metadata": metadata,
	}
}

func connectOp(from string, to string) map[string]any {
	return map[string]any{"type": "connect_nodes", "fromNodeId": from, "toNodeId": to}
}

func ptr[T any](value T) *T {
	return kernel.Ptr(value)
}

func shortTitle(value string, max int) string {
	title := strings.TrimSpace(value)
	if title == "" {
		title = "影视分镜"
	}
	if len([]rune(title)) > max {
		return string([]rune(title)[:max]) + "..."
	}
	return title
}

func defaultString(value string, fallback string) string {
	return kernel.DefaultString(value, fallback)
}

func newID() string {
	return kernel.NewID()
}
