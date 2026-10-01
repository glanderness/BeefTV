package app

import (
	"context"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// LocalKernel is the intentionally narrow desktop-facing surface of Service.
// Method values prevent interface reflection from retaining the full Service
// method set, while keeping that linker concern out of the composition root.
type LocalKernel struct {
	tasksWithOptions  func(string, localtask.ListOptions) ([]localtask.Summary, error)
	createLocalTask   func(string, localtask.CreateRequest) (*model.Task, error)
	allowRequest      func(context.Context, string, int, time.Duration) (bool, error)
	requestRetryAfter func(context.Context, string, time.Duration) time.Duration
	startWorker       func()
	stopWorker        func(context.Context) error
	close             func() error
}

func NewLocalKernel(service *Service) *LocalKernel {
	return &LocalKernel{
		tasksWithOptions: service.TasksWithOptions,
		createLocalTask:  service.CreateLocalTask, allowRequest: service.AllowRequest,
		requestRetryAfter: service.RequestRetryAfter, startWorker: service.StartWorker,
		stopWorker: service.StopWorker, close: service.Close,
	}
}

func (k *LocalKernel) TasksWithOptions(userID string, options localtask.ListOptions) ([]localtask.Summary, error) {
	return k.tasksWithOptions(userID, options)
}

func (k *LocalKernel) CreateLocalTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return k.createLocalTask(userID, request)
}

func (k *LocalKernel) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	return k.allowRequest(ctx, key, limit, window)
}

func (k *LocalKernel) RequestRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	return k.requestRetryAfter(ctx, key, window)
}

func (k *LocalKernel) StartWorker() { k.startWorker() }

func (k *LocalKernel) StopWorker(ctx context.Context) error { return k.stopWorker(ctx) }

func (k *LocalKernel) Close() error { return k.close() }
