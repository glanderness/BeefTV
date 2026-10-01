package taskruntime

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// Runtime 拥有任务领取循环、槽位/任务租约续期、有界并发、排空和已领取任务的执行窗口。
// 供应商协议与终态业务策略不进入本包。
type Runtime struct {
	worker      WorkerHost
	repo        Repository
	coordinator Coordinator
	policy      Policy
	executor    Executor
	results     ResultWriter
	cancels     CancelRegistry
	logf        func(string, ...any)
	onExecError func(*model.Task, error)
	cfg         Config
	closed      atomic.Bool
}

// Deps 是运行时端口。Worker 必须是进程里那一个 platform.Worker，不能再造一套生命周期。
type Deps struct {
	Worker      WorkerHost
	Repository  Repository
	Coordinator Coordinator
	Policy      Policy
	Executor    Executor
	Results     ResultWriter
	Cancels     CancelRegistry
	Logger      func(string, ...any)
	OnExecError func(*model.Task, error)
	Config      Config
}

func New(deps Deps) *Runtime {
	if deps.Logger == nil {
		deps.Logger = log.Printf
	}
	return &Runtime{
		worker:      deps.Worker,
		repo:        deps.Repository,
		coordinator: deps.Coordinator,
		policy:      deps.Policy,
		executor:    deps.Executor,
		results:     deps.Results,
		cancels:     deps.Cancels,
		logf:        deps.Logger,
		onExecError: deps.OnExecError,
		cfg:         deps.Config.withDefaults(),
	}
}

func (c Config) withDefaults() Config {
	if c.SlotScope == "" {
		c.SlotScope = "workers"
	}
	if c.SlotTTL <= 0 {
		c.SlotTTL = time.Minute
	}
	if c.TaskLeaseTTL <= 0 {
		c.TaskLeaseTTL = 45 * time.Second
	}
	if c.ClaimTimeout <= 0 {
		c.ClaimTimeout = 5 * time.Second
	}
	if c.RenewInterval <= 0 {
		c.RenewInterval = 15 * time.Second
	}
	if c.DispatchInterval <= 0 {
		c.DispatchInterval = 2 * time.Second
	}
	if c.MaxSlots <= 0 {
		c.MaxSlots = 999
	}
	workerID := c.WorkerID
	if c.NewOwner == nil {
		c.NewOwner = func() string {
			id := kernel.NewID()
			if strings.TrimSpace(workerID) == "" {
				return id
			}
			return workerID + ":" + id
		}
	}
	return c
}

// Start 启动共享 Worker 并挂上领取循环。重复调用是幂等的。
func (r *Runtime) Start() (context.Context, bool) {
	if r == nil || r.closed.Load() || r.worker == nil {
		return nil, false
	}
	ctx, started := r.worker.Start()
	if !started {
		return ctx, false
	}
	if !r.worker.GoLoop(r.dispatchLoop) {
		return ctx, false
	}
	return ctx, true
}

// StartLoop 在调用方已经 Start 共享 Worker 之后挂上领取循环。
func (r *Runtime) StartLoop() bool {
	if r == nil || r.closed.Load() || r.worker == nil {
		return false
	}
	return r.worker.GoLoop(r.dispatchLoop)
}

// Close 禁止再领取或派发新任务。进行中的执行仍由共享 Worker.Stop 等待。
func (r *Runtime) Close() {
	if r == nil {
		return
	}
	r.closed.Store(true)
}

func (r *Runtime) Closed() bool {
	return r != nil && r.closed.Load()
}

// Dispatch 同步跑一轮领取。测试用它避免等待调度 tick。
func (r *Runtime) Dispatch(ctx context.Context) {
	if r == nil {
		return
	}
	r.dispatch(ctx, make(chan struct{}, r.cfg.MaxSlots))
}

// ProcessOne 领取并执行一条任务，不占用全局槽位。兼容现有 ProcessNextTask 测试入口。
func (r *Runtime) ProcessOne(ctx context.Context) Outcome {
	if r == nil || r.closed.Load() {
		return Outcome{Kind: KindFailed, Err: errors.New("任务运行时已关闭")}
	}
	if r.repo == nil {
		return Outcome{Kind: KindFailed, Err: errors.New("任务仓库未初始化")}
	}
	owner := r.cfg.NewOwner()
	task, err := r.repo.ClaimNext(ctx, owner, r.cfg.TaskLeaseTTL)
	if err != nil || task == nil {
		return Outcome{Err: err}
	}
	return r.runClaimed(task, nil)
}

func (r *Runtime) dispatchLoop(ctx context.Context) {
	slots := make(chan struct{}, r.cfg.MaxSlots)
	r.dispatch(ctx, slots)
	ticker := time.NewTicker(r.cfg.DispatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.dispatch(ctx, slots)
		}
	}
}

func (r *Runtime) dispatch(ctx context.Context, slots chan struct{}) {
	if r.closed.Load() || ctx.Err() != nil || r.worker == nil || r.worker.IsDraining() {
		return
	}
	if r.policy == nil {
		r.logf("task dispatch paused: stage=runtime_policy worker_id=%s error=%v", r.cfg.WorkerID, errors.New("调度策略未初始化"))
		return
	}
	concurrency, err := r.policy.WorkerConcurrency(ctx)
	if err != nil {
		r.logf("task dispatch paused: stage=runtime_policy worker_id=%s error=%v", r.cfg.WorkerID, err)
		return
	}
	for len(slots) < concurrency {
		if r.closed.Load() || ctx.Err() != nil || r.worker.IsDraining() {
			return
		}
		if r.coordinator == nil {
			r.logf("task dispatch paused: stage=global_slot worker_id=%s error=%v", r.cfg.WorkerID, errors.New("运行时协调器未初始化"))
			return
		}
		slot, acquired, err := r.coordinator.AcquireLease(ctx, r.cfg.SlotScope, concurrency, r.cfg.SlotTTL)
		if err != nil || !acquired {
			if err != nil {
				r.logf("task dispatch paused: stage=global_slot worker_id=%s error=%v", r.cfg.WorkerID, err)
			}
			return
		}
		claimCtx, cancelClaim := context.WithTimeout(ctx, r.cfg.ClaimTimeout)
		task, err := r.repo.ClaimNext(claimCtx, slot.Token(), r.cfg.TaskLeaseTTL)
		cancelClaim()
		if err != nil || task == nil {
			slot.Release()
			if err != nil {
				r.logf("task dispatch paused: stage=claim worker_id=%s error=%v", r.cfg.WorkerID, err)
			}
			return
		}
		slots <- struct{}{}
		started := r.worker.GoTask(func() {
			defer func() { <-slots; slot.Release() }()
			outcome := r.runClaimed(task, slot)
			if outcome.Err != nil && r.onExecError != nil {
				r.onExecError(task, outcome.Err)
			}
		})
		if !started {
			<-slots
			slot.Release()
			_ = r.repo.ReleaseLease(task.ID, task.LeaseOwner)
			return
		}
	}
}

func (r *Runtime) runClaimed(task *model.Task, slot SlotLease) Outcome {
	if r.closed.Load() {
		if r.repo != nil && task != nil {
			_ = r.repo.ReleaseLease(task.ID, task.LeaseOwner)
		}
		if slot != nil {
			slot.Release()
		}
		return Outcome{Kind: KindFailed, Err: errors.New("任务运行时已关闭")}
	}
	timeout := 15 * time.Minute
	if r.policy != nil {
		value, err := r.policy.ExecutionTimeout(context.Background(), task.Type)
		if err != nil {
			return Outcome{Kind: KindFailed, Err: err}
		}
		timeout = value
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	session := newSession(ctx, task, r.results)
	if r.cancels != nil {
		r.cancels.Register(task.ID, cancel)
		defer r.cancels.Unregister(task.ID)
	}
	stopRenew := make(chan struct{})
	var renewers sync.WaitGroup
	renewers.Add(1)
	go func() {
		defer renewers.Done()
		r.renewLoop(ctx, cancel, task, slot, session, stopRenew)
	}()
	defer func() {
		close(stopRenew)
		renewers.Wait()
	}()
	outcome := r.executor.Execute(session)
	return r.finish(ctx, session, outcome)
}

func (r *Runtime) renewLoop(ctx context.Context, cancel context.CancelFunc, task *model.Task, slot SlotLease, session *session, stop <-chan struct{}) {
	ticker := time.NewTicker(r.cfg.RenewInterval)
	defer ticker.Stop()
	taskID, owner := task.ID, task.LeaseOwner
	for {
		select {
		case <-ticker.C:
			renewCtx, cancelRenew := context.WithTimeout(ctx, 5*time.Second)
			var err error
			if slot != nil {
				err = slot.Renew(renewCtx)
			}
			if err == nil && r.repo != nil {
				err = r.repo.RenewLease(renewCtx, taskID, owner, r.cfg.TaskLeaseTTL)
			}
			cancelRenew()
			if err != nil {
				session.markLost(err)
				cancel()
				return
			}
		case <-stop:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (r *Runtime) finish(ctx context.Context, session *session, outcome Outcome) Outcome {
	if lost := session.LostErr(); lost != nil {
		if outcome.Applied {
			return outcome
		}
		if outcome.Kind == KindCompleted {
			if outcome.ProviderAccepted {
				outcome = Outcome{Kind: KindUncertain, Err: fmt.Errorf("任务租约失效，停止保存上游结果：%w", lost), ProviderAccepted: true}
			} else {
				outcome = Outcome{Kind: KindLeaseLost, Err: fmt.Errorf("任务租约失效，停止保存上游结果：%w", lost)}
			}
		}
		if r.results != nil && !session.DidCommit() {
			if writeErr := r.results.Write(ctx, session.Task(), outcome); writeErr == nil {
				outcome.Applied = true
			}
		}
		return outcome
	}
	if !outcome.Applied && r.results != nil && !session.DidCommit() {
		if writeErr := r.results.Write(ctx, session.Task(), outcome); writeErr == nil {
			outcome.Applied = true
		} else if outcome.Err == nil {
			outcome.Err = writeErr
		}
	}
	return outcome
}
