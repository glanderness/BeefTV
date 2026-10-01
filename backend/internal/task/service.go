package task

import (
	"context"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type Backend interface {
	TasksWithOptions(string, ListOptions) ([]Summary, error)
	CreateLocalTask(string, CreateRequest) (*model.Task, error)
	StartWorker()
	StopWorker(context.Context) error
	Close() error
}

// Service is the local task admission and lifecycle boundary.
//
// New(backend) is the bootstrap facade: CreateTask forwards to the desktop
// kernel, which then re-enters the real domain through app.CreateLocalTask.
// NewService is the domain constructor. Keeping New is a temporary root-cut
// compatibility shim; bootstrap still does not compose the domain directly.
type Service struct {
	backend Backend
	store   Store
	deps    Dependencies
}

func New(backend Backend) *Service { return &Service{backend: backend} }

func NewService(store Store, deps Dependencies) *Service {
	if deps.NewID == nil {
		deps.NewID = kernel.NewID
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Service{store: store, deps: deps}
}

func (s *Service) TasksWithOptions(userID string, options ListOptions) ([]Summary, error) {
	if s != nil && s.backend != nil {
		return s.backend.TasksWithOptions(userID, options)
	}
	return s.list(userID, options)
}

func (s *Service) CreateTask(userID string, request CreateRequest) (*model.Task, error) {
	if s != nil && s.backend != nil {
		return s.backend.CreateLocalTask(userID, request)
	}
	return s.admit(userID, request)
}

func (s *Service) StartWorker() {
	if s != nil && s.backend != nil {
		s.backend.StartWorker()
	}
}

func (s *Service) StopWorker(ctx context.Context) error {
	if s != nil && s.backend != nil {
		return s.backend.StopWorker(ctx)
	}
	return nil
}

func (s *Service) Close() error {
	if s != nil && s.backend != nil {
		return s.backend.Close()
	}
	return nil
}

func (s *Service) newID() string {
	if s != nil && s.deps.NewID != nil {
		return s.deps.NewID()
	}
	return kernel.NewID()
}

func (s *Service) now() time.Time {
	if s != nil && s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}

func presentTask(present Presenter, task model.Task) *model.Task {
	if present != nil {
		return present.Task(task)
	}
	copied := task
	return &copied
}

func presentSummaries(present Presenter, tasks []model.Task) []Summary {
	if present != nil {
		return present.Summaries(tasks)
	}
	return nil
}

func presentLogs(present Presenter, logs []model.TaskLog) []model.TaskLog {
	if present != nil {
		return present.Logs(logs)
	}
	return logs
}

func (s *Service) log(userID, taskID, level, message, payload string) {
	if s == nil || s.deps.Logs == nil {
		return
	}
	_ = s.deps.Logs.Log(userID, taskID, level, message, payload)
}

func (s *Service) hydrateProviderRequestID(task *model.Task) {
	if task == nil || task.ProviderRequestID != "" || s == nil || s.store == nil {
		return
	}
	if providerRequestID, err := s.store.LatestProviderRequestID(task.ID); err == nil {
		task.ProviderRequestID = providerRequestID
	}
}

// ValidateRetryType is the public retryOf type/image-recovery guard used by
// canvas retry construction. Authorization is the caller's userID.
func (s *Service) ValidateRetryType(userID, taskType string, input map[string]any) error {
	return s.validateRetryType(userID, taskType, input)
}
