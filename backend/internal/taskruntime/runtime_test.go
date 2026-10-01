package taskruntime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

type staticPolicy struct {
	n       int
	timeout time.Duration
	err     error
}

func (p staticPolicy) WorkerConcurrency(context.Context) (int, error) {
	if p.err != nil {
		return 0, p.err
	}
	if p.n == 0 {
		return 1, nil
	}
	return p.n, nil
}

func (p staticPolicy) ExecutionTimeout(context.Context, string) (time.Duration, error) {
	if p.err != nil {
		return 0, p.err
	}
	if p.timeout == 0 {
		return time.Minute, nil
	}
	return p.timeout, nil
}

type fnExec func(Session) Outcome

func (f fnExec) Execute(session Session) Outcome { return f(session) }

type cancelMap struct {
	mu         sync.Mutex
	m          map[string]context.CancelFunc
	onRegister func(string)
}

func (c *cancelMap) Register(taskID string, cancel context.CancelFunc) {
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]context.CancelFunc{}
	}
	c.m[taskID] = cancel
	cb := c.onRegister
	c.mu.Unlock()
	if cb != nil {
		cb(taskID)
	}
}

func (c *cancelMap) Unregister(taskID string) {
	c.mu.Lock()
	delete(c.m, taskID)
	c.mu.Unlock()
}

func (c *cancelMap) Cancel(taskID string) {
	c.mu.Lock()
	fn := c.m[taskID]
	c.mu.Unlock()
	if fn != nil {
		fn()
	}
}

type memoryRepo struct {
	mu        sync.Mutex
	task      *model.Task
	claimErr  error
	failRenew atomic.Bool
	releases  []string
	writes    []Outcome
	terminal  bool
}

func queuedTask(id string) *model.Task {
	return &model.Task{ID: id, UserID: "user", Type: "canvas_text", Status: model.TaskStatusQueued, RequestID: "req-" + id}
}

func (m *memoryRepo) ClaimNext(_ context.Context, owner string, ttl time.Duration) (*model.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.claimErr != nil {
		return nil, m.claimErr
	}
	if m.task == nil || m.terminal {
		return nil, nil
	}
	now := time.Now()
	leaseValid := m.task.LeaseOwner != "" && m.task.LeaseExpiresAt != nil && m.task.LeaseExpiresAt.After(now)
	if m.task.Status == model.TaskStatusRunning && leaseValid {
		return nil, nil
	}
	if m.task.Status != model.TaskStatusQueued && m.task.Status != model.TaskStatusRunning {
		return nil, nil
	}
	m.task.Status = model.TaskStatusRunning
	m.task.LeaseOwner = owner
	exp := now.Add(ttl)
	m.task.LeaseExpiresAt = &exp
	m.task.Attempts++
	copy := *m.task
	return &copy, nil
}

func (m *memoryRepo) RenewLease(_ context.Context, taskID, owner string, ttl time.Duration) error {
	if m.failRenew.Load() {
		return errors.New("任务租约已失效")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.task == nil || m.task.ID != taskID || m.task.LeaseOwner != owner {
		return errors.New("任务租约已失效")
	}
	exp := time.Now().Add(ttl)
	m.task.LeaseExpiresAt = &exp
	return nil
}

func (m *memoryRepo) ReleaseLease(taskID, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.releases = append(m.releases, owner)
	if m.task != nil && m.task.ID == taskID && m.task.LeaseOwner == owner {
		m.task.LeaseOwner = ""
		m.task.LeaseExpiresAt = nil
	}
	return nil
}

func (m *memoryRepo) Write(_ context.Context, _ *model.Task, outcome Outcome) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writes = append(m.writes, outcome)
	switch outcome.Kind {
	case KindUncertain, KindCompleted, KindFailed, KindCancelled, KindRejected:
		m.terminal = true
		if m.task != nil {
			m.task.LeaseOwner = ""
			m.task.LeaseExpiresAt = nil
			if outcome.Kind == KindCompleted {
				m.task.Status = model.TaskStatusSucceeded
			} else if outcome.Kind == KindCancelled {
				m.task.Status = model.TaskStatusCancelled
			} else {
				m.task.Status = model.TaskStatusFailed
				if outcome.Kind == KindUncertain {
					m.task.Stage = "submission_unknown"
				}
			}
		}
	}
	return nil
}

func (m *memoryRepo) expireLease() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.task == nil {
		return
	}
	past := time.Now().Add(-time.Second)
	m.task.LeaseExpiresAt = &past
}

func (m *memoryRepo) writeKinds() []Kind {
	m.mu.Lock()
	defer m.mu.Unlock()
	kinds := make([]Kind, 0, len(m.writes))
	for _, item := range m.writes {
		kinds = append(kinds, item.Kind)
	}
	return kinds
}

type slotCoordinator struct {
	inner *platform.Coordinator
}

func (s slotCoordinator) AcquireLease(ctx context.Context, scope string, limit int, ttl time.Duration) (SlotLease, bool, error) {
	return s.inner.AcquireLease(ctx, scope, limit, ttl)
}

type rejectTaskHost struct {
	inner *platform.Worker
}

func (h *rejectTaskHost) Start() (context.Context, bool) { return h.inner.Start() }
func (h *rejectTaskHost) GoLoop(fn func(context.Context)) bool {
	return h.inner.GoLoop(fn)
}
func (h *rejectTaskHost) GoTask(func()) bool { return false }
func (h *rejectTaskHost) BeginDrain()        { h.inner.BeginDrain() }
func (h *rejectTaskHost) Stop(ctx context.Context) error {
	return h.inner.Stop(ctx)
}
func (h *rejectTaskHost) IsDraining() bool { return false }

type countingHost struct {
	inner *platform.Worker
	loops atomic.Int32
}

func (h *countingHost) Start() (context.Context, bool) { return h.inner.Start() }
func (h *countingHost) GoLoop(fn func(context.Context)) bool {
	if h.inner.GoLoop(fn) {
		h.loops.Add(1)
		return true
	}
	return false
}
func (h *countingHost) GoTask(fn func()) bool { return h.inner.GoTask(fn) }
func (h *countingHost) BeginDrain()           { h.inner.BeginDrain() }
func (h *countingHost) Stop(ctx context.Context) error {
	return h.inner.Stop(ctx)
}
func (h *countingHost) IsDraining() bool { return h.inner.IsDraining() }

func testRuntime(t *testing.T, deps Deps) *Runtime {
	t.Helper()
	if deps.Worker == nil {
		worker := &platform.Worker{}
		if _, started := worker.Start(); !started {
			t.Fatal("worker should start")
		}
		deps.Worker = worker
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = worker.Stop(ctx)
		})
	}
	if deps.Policy == nil {
		deps.Policy = staticPolicy{n: 1, timeout: time.Minute}
	}
	if deps.Coordinator == nil {
		deps.Coordinator = slotCoordinator{inner: platform.NewLocalCoordinator()}
	}
	if deps.Logger == nil {
		deps.Logger = func(string, ...any) {}
	}
	deps.Config.DispatchInterval = time.Hour
	if deps.Config.RenewInterval == 0 {
		deps.Config.RenewInterval = time.Hour
	}
	return New(deps)
}

func TestConcurrentClaimGivesSingleLeaseOwner(t *testing.T) {
	repo := &memoryRepo{task: queuedTask("task-1")}
	var executes atomic.Int32
	var owners sync.Map
	exec := fnExec(func(session Session) Outcome {
		executes.Add(1)
		owners.Store(session.Task().LeaseOwner, true)
		return Outcome{Kind: KindCompleted}
	})
	left := testRuntime(t, Deps{Repository: repo, Executor: exec, Results: repo, Policy: staticPolicy{n: 2}})
	right := testRuntime(t, Deps{Repository: repo, Executor: exec, Results: repo, Policy: staticPolicy{n: 2}, Coordinator: left.coordinator})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); left.Dispatch(context.Background()) }()
	go func() { defer wg.Done(); right.Dispatch(context.Background()) }()
	wg.Wait()
	deadline := time.Now().Add(time.Second)
	for executes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if executes.Load() != 1 {
		t.Fatalf("executes=%d, want 1", executes.Load())
	}
	count := 0
	owners.Range(func(any, any) bool { count++; return true })
	if count != 1 {
		t.Fatalf("owners=%d, want 1", count)
	}
}

func TestCancelWhileWaitingAndExecuting(t *testing.T) {
	t.Run("waiting", func(t *testing.T) {
		repo := &memoryRepo{task: queuedTask("wait")}
		var work atomic.Int32
		started := make(chan struct{})
		cancels := &cancelMap{}
		exec := fnExec(func(session Session) Outcome {
			close(started)
			select {
			case <-session.Context().Done():
				return Outcome{Kind: KindCancelled, Err: session.Context().Err()}
			case <-time.After(time.Second):
				work.Add(1)
				return Outcome{Kind: KindCompleted, ProviderAccepted: true}
			}
		})
		rt := testRuntime(t, Deps{Repository: repo, Executor: exec, Results: repo, Cancels: cancels})
		rt.Dispatch(context.Background())
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("executor did not wait")
		}
		cancels.Cancel("wait")
		deadline := time.Now().Add(time.Second)
		for !repo.terminal && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if work.Load() != 0 {
			t.Fatal("cancelled waiter still submitted upstream")
		}
		if kinds := repo.writeKinds(); len(kinds) != 1 || kinds[0] != KindCancelled {
			t.Fatalf("writes=%v, want cancelled", kinds)
		}
	})
	t.Run("executing", func(t *testing.T) {
		repo := &memoryRepo{task: queuedTask("exec")}
		var submitted atomic.Int32
		entered := make(chan struct{})
		cancels := &cancelMap{}
		exec := fnExec(func(session Session) Outcome {
			submitted.Add(1)
			close(entered)
			<-session.Context().Done()
			return Outcome{Kind: KindCancelled, Err: session.Context().Err(), ProviderAccepted: true}
		})
		rt := testRuntime(t, Deps{Repository: repo, Executor: exec, Results: repo, Cancels: cancels})
		rt.Dispatch(context.Background())
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("executor did not start")
		}
		cancels.Cancel("exec")
		deadline := time.Now().Add(time.Second)
		for !repo.terminal && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if submitted.Load() != 1 {
			t.Fatalf("submits=%d", submitted.Load())
		}
		if kinds := repo.writeKinds(); len(kinds) != 1 || kinds[0] != KindCancelled {
			t.Fatalf("writes=%v, want cancelled", kinds)
		}
	})
}

func TestLeaseLossRejectsStaleCompletion(t *testing.T) {
	repo := &memoryRepo{task: queuedTask("lease")}
	started := make(chan struct{})
	result := make(chan Outcome, 1)
	exec := fnExec(func(session Session) Outcome {
		close(started)
		<-session.Context().Done()
		err := session.Commit(Outcome{Kind: KindCompleted, ProviderAccepted: true})
		if err == nil {
			return Outcome{Kind: KindCompleted, ProviderAccepted: true, Applied: true}
		}
		return Outcome{Kind: KindLeaseLost, Err: err, ProviderAccepted: true}
	})
	rt := testRuntime(t, Deps{
		Repository: repo,
		Executor:   exec,
		Results:    repo,
		Config:     Config{RenewInterval: 5 * time.Millisecond},
	})
	go func() { result <- rt.ProcessOne(context.Background()) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("executor did not start")
	}
	repo.failRenew.Store(true)
	select {
	case outcome := <-result:
		if outcome.Kind == KindCompleted {
			t.Fatal("lease loss committed completion")
		}
		if outcome.Kind != KindLeaseLost && outcome.Kind != KindUncertain {
			t.Fatalf("kind=%s", outcome.Kind)
		}
		if !errors.Is(outcome.Err, ErrLeaseLost) {
			t.Fatalf("err=%v", outcome.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("process did not finish after lease loss")
	}
	for _, kind := range repo.writeKinds() {
		if kind == KindCompleted {
			t.Fatal("result writer stored stale completion")
		}
	}
	repo.mu.Lock()
	status := repo.task.Status
	repo.mu.Unlock()
	if status == model.TaskStatusSucceeded {
		t.Fatal("task marked succeeded after lease loss")
	}
}

func TestStopDrainPreventsNewTasks(t *testing.T) {
	repo := &memoryRepo{task: queuedTask("drain")}
	var executes atomic.Int32
	rt := testRuntime(t, Deps{Repository: repo, Executor: fnExec(func(Session) Outcome {
		executes.Add(1)
		return Outcome{Kind: KindCompleted}
	}), Results: repo})
	rt.worker.BeginDrain()
	rt.Dispatch(context.Background())
	time.Sleep(20 * time.Millisecond)
	if executes.Load() != 0 {
		t.Fatal("drain still dispatched work")
	}
	if rt.worker.GoTask(func() {}) {
		t.Fatal("draining worker accepted a new task")
	}
}

func TestRepeatStartIsIdempotent(t *testing.T) {
	host := &countingHost{inner: &platform.Worker{}}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = host.Stop(ctx)
	})
	rt := testRuntime(t, Deps{
		Worker:     host,
		Repository: &memoryRepo{},
		Executor:   fnExec(func(Session) Outcome { return Outcome{Kind: KindCompleted} }),
	})
	if _, started := rt.Start(); !started {
		t.Fatal("first start should succeed")
	}
	if _, started := rt.Start(); started {
		t.Fatal("second start should be idempotent")
	}
	if host.loops.Load() != 1 {
		t.Fatalf("loops=%d, want 1", host.loops.Load())
	}
}

func TestSlotReleasedOnClaimErrorAndRejectedStart(t *testing.T) {
	t.Run("claim error", func(t *testing.T) {
		inner := platform.NewLocalCoordinator()
		repo := &memoryRepo{claimErr: errors.New("claim failed")}
		rt := testRuntime(t, Deps{Repository: repo, Coordinator: slotCoordinator{inner: inner}, Executor: fnExec(func(Session) Outcome {
			t.Fatal("executor should not run")
			return Outcome{}
		})})
		rt.Dispatch(context.Background())
		lease, acquired, err := inner.AcquireLease(context.Background(), "workers", 1, time.Minute)
		if err != nil || !acquired {
			t.Fatalf("slot not released after claim error: acquired=%v err=%v", acquired, err)
		}
		lease.Release()
	})
	t.Run("go task rejected", func(t *testing.T) {
		worker := &platform.Worker{}
		if _, started := worker.Start(); !started {
			t.Fatal("worker should start")
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = worker.Stop(ctx)
		})
		inner := platform.NewLocalCoordinator()
		repo := &memoryRepo{task: queuedTask("reject")}
		rt := New(Deps{
			Worker:      &rejectTaskHost{inner: worker},
			Repository:  repo,
			Coordinator: slotCoordinator{inner: inner},
			Policy:      staticPolicy{n: 1, timeout: time.Minute},
			Executor:    fnExec(func(Session) Outcome { t.Fatal("executor should not run"); return Outcome{} }),
			Logger:      func(string, ...any) {},
			Config:      Config{DispatchInterval: time.Hour, RenewInterval: time.Hour},
		})
		rt.Dispatch(context.Background())
		if len(repo.releases) != 1 {
			t.Fatalf("releases=%v, want task lease released", repo.releases)
		}
		lease, acquired, err := inner.AcquireLease(context.Background(), "workers", 1, time.Minute)
		if err != nil || !acquired {
			t.Fatalf("slot not released after rejected start: acquired=%v err=%v", acquired, err)
		}
		lease.Release()
	})
}

func TestUnknownStateDoesNotResubmit(t *testing.T) {
	repo := &memoryRepo{task: queuedTask("unknown")}
	var submits atomic.Int32
	first := make(chan struct{})
	exec := fnExec(func(Session) Outcome {
		n := submits.Add(1)
		if n == 1 {
			close(first)
		}
		return Outcome{Kind: KindUncertain, ProviderAccepted: true}
	})
	rt := testRuntime(t, Deps{Repository: repo, Executor: exec, Results: repo})
	rt.Dispatch(context.Background())
	select {
	case <-first:
	case <-time.After(time.Second):
		t.Fatal("first execute did not run")
	}
	deadline := time.Now().Add(time.Second)
	for !repo.terminal && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	repo.expireLease()
	rt.Dispatch(context.Background())
	time.Sleep(30 * time.Millisecond)
	if submits.Load() != 1 {
		t.Fatalf("submits=%d, uncertain outcome was resubmitted", submits.Load())
	}
	if kinds := repo.writeKinds(); len(kinds) != 1 || kinds[0] != KindUncertain {
		t.Fatalf("writes=%v, want uncertain", kinds)
	}
	if (Outcome{Kind: KindUncertain, ProviderAccepted: true}).Resubmittable() {
		t.Fatal("uncertain accepted work must not be resubmittable")
	}
}

func TestCloseDoesNotSpawnWork(t *testing.T) {
	repo := &memoryRepo{task: queuedTask("closed")}
	var executes atomic.Int32
	rt := testRuntime(t, Deps{Repository: repo, Executor: fnExec(func(Session) Outcome {
		executes.Add(1)
		return Outcome{Kind: KindCompleted}
	}), Results: repo})
	rt.Close()
	if _, started := rt.Start(); started {
		t.Fatal("start after close spawned a new lifetime")
	}
	rt.Dispatch(context.Background())
	if executes.Load() != 0 {
		t.Fatal("close still spawned work")
	}
	if rt.StartLoop() {
		t.Fatal("closed runtime started a new loop")
	}
	fresh := &platform.Worker{}
	closed := New(Deps{
		Worker:      fresh,
		Repository:  repo,
		Coordinator: slotCoordinator{inner: platform.NewLocalCoordinator()},
		Policy:      staticPolicy{n: 1, timeout: time.Minute},
		Executor:    fnExec(func(Session) Outcome { executes.Add(1); return Outcome{Kind: KindCompleted} }),
		Logger:      func(string, ...any) {},
		Config:      Config{DispatchInterval: time.Hour, RenewInterval: time.Hour},
	})
	closed.Close()
	if _, started := closed.Start(); started {
		t.Fatal("closed runtime started a worker loop")
	}
}

func TestProcessOnePreservesOwnerAndDoesNotNeedSlot(t *testing.T) {
	repo := &memoryRepo{task: queuedTask("one")}
	var owner string
	rt := testRuntime(t, Deps{
		Repository: repo,
		Executor: fnExec(func(session Session) Outcome {
			owner = session.Task().LeaseOwner
			return Outcome{Kind: KindRejected}
		}),
		Results: repo,
		Config:  Config{WorkerID: "worker-a", NewOwner: func() string { return "worker-a:attempt-1" }},
	})
	outcome := rt.ProcessOne(context.Background())
	if outcome.Kind != KindRejected {
		t.Fatalf("kind=%s", outcome.Kind)
	}
	if owner != "worker-a:attempt-1" {
		t.Fatalf("owner=%q", owner)
	}
}
