package app

import (
	"context"
	"log"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/taskruntime"
)

type appWorkerHost struct{ service *Service }

func (h appWorkerHost) Start() (context.Context, bool) {
	return h.service.backgroundWorkers().Start()
}

func (h appWorkerHost) GoLoop(fn func(context.Context)) bool {
	return h.service.backgroundWorkers().GoLoop(fn)
}

func (h appWorkerHost) GoTask(fn func()) bool {
	return h.service.backgroundWorkers().GoTask(fn)
}

func (h appWorkerHost) BeginDrain() { h.service.backgroundWorkers().BeginDrain() }

func (h appWorkerHost) Stop(ctx context.Context) error {
	return h.service.backgroundWorkers().Stop(ctx)
}

func (h appWorkerHost) IsDraining() bool { return h.service.backgroundWorkers().IsDraining() }

type appTaskPolicy struct{ service *Service }

func (p appTaskPolicy) WorkerConcurrency(ctx context.Context) (int, error) {
	_ = ctx
	setting, err := p.service.runtimeConcurrencySetting()
	if err != nil {
		return 0, err
	}
	return setting.WorkerConcurrency, nil
}

func (p appTaskPolicy) ExecutionTimeout(_ context.Context, taskType string) (time.Duration, error) {
	policyCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	policy, err := p.service.runtimePolicyWithRepo(p.service.repo.WithContext(policyCtx))
	if err != nil {
		return 0, err
	}
	return taskExecutionTimeoutWithPolicy(taskType, policy.Task), nil
}

type appTaskExecutor struct{ coordinator *taskWorkerCoordinator }

func (e appTaskExecutor) Execute(session taskruntime.Session) taskruntime.Outcome {
	return e.coordinator.executeClaimed(session)
}

type appCancelRegistry struct{ service *Service }

func (c appCancelRegistry) Register(taskID string, cancel context.CancelFunc) {
	c.service.registerActiveTask(taskID, cancel)
}

func (c appCancelRegistry) Unregister(taskID string) {
	c.service.unregisterActiveTask(taskID)
}

func newAppTaskRuntime(w *taskWorkerCoordinator) *taskruntime.Runtime {
	s := w.service
	singleProcess := s.repo.SingleProcess()
	return taskruntime.New(taskruntime.Deps{
		Worker:      appWorkerHost{service: s},
		Repository:  taskruntime.NewRepositoryAdapter(s.repo, singleProcess),
		Coordinator: taskruntime.NewSlotCoordinatorAdapter(s.coordinator, singleProcess),
		Policy:      appTaskPolicy{service: s},
		Executor:    appTaskExecutor{coordinator: w},
		Cancels:     appCancelRegistry{service: s},
		Logger:      log.Printf,
		OnExecError: func(task *model.Task, err error) {
			if latest, readErr := s.repo.Task(task.ID); readErr == nil && latest.Status == model.TaskStatusSucceeded {
				// Completion already records delivery/registration errors. Do not
				// describe a recoverable download as a failed generation.
				return
			}
			_ = s.log(task.UserID, task.ID, "error", "后台任务处理失败", generation.DiagnosticSummary(err.Error()))
		},
		Config: taskruntime.Config{
			WorkerID:      s.workerID,
			SlotTTL:       workerSlotLeaseDuration,
			MaxSlots:      maxChannelConcurrencyLimit,
			SingleProcess: singleProcess,
		},
	})
}
