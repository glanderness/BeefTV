package assistantruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultBusinessTaskSignal   = "business_task_settled"
	defaultTaskWaitPollInterval = 5 * time.Second
	defaultSignalDispatchWait   = 10 * time.Second
	defaultRetryBackoffBase     = 500 * time.Millisecond
	defaultRetryBackoffMax      = 30 * time.Second
	taskWaitMaxAge              = 24 * time.Hour
	taskWaitsFileName           = "assistant-task-waits.json"
)

// TaskWaitSubscription persists a parked ToolPark invocation waiting for one or
// more backend business tasks to reach a terminal state.
type TaskWaitSubscription struct {
	UserID           string   `json:"userId"`
	CanvasID         string   `json:"canvasId"`
	SessionID        string   `json:"sessionId"`
	DurableTaskID    int64    `json:"durableTaskId"`
	Signal           string   `json:"signal"`
	TaskIDs          []string `json:"taskIds"`
	DeliveredTaskIDs []string `json:"deliveredTaskIds,omitempty"`
	CreatedAt        string   `json:"createdAt"`
}

// TaskWaitEvaluation is the domain-neutral evaluation returned by the caller's
// task lookup so assistantruntime stays decoupled from internal/app.
type TaskWaitEvaluation struct {
	Settled  bool
	NotFound bool
	Payload  map[string]any
}

// TaskWaitEvaluator inspects a business task and reports whether it has reached
// a terminal wait state ready to wake a parked ToolPark task.
type TaskWaitEvaluator func(ctx context.Context, userID, taskID string) (TaskWaitEvaluation, error)

type subControl struct {
	epoch  uint64
	ctx    context.Context
	cancel context.CancelFunc
}

// TaskWaitRegistry stores active parked-tool wait subscriptions (optionally
// persisted under DataDir) and dispatches POST /signals to agent-host as soon
// as subscribed business tasks settle, fail, or cancel.
type TaskWaitRegistry struct {
	host            *Host
	filePath        string
	notifyCh        chan struct{}
	mu              sync.Mutex
	subs            map[string]TaskWaitSubscription
	subCtrl         map[string]*subControl
	nextEpoch       uint64
	retryFailures   map[string]int
	nextAttemptAt   map[string]time.Time
	evaluator       TaskWaitEvaluator
	pollInterval    time.Duration
	dispatchTimeout time.Duration
	backoffBase     time.Duration
	backoffMax      time.Duration
	closed          bool
	paused          bool
	watching        bool
	cancelWatch     context.CancelFunc
	watchDone       chan struct{}
}

func newTaskWaitRegistry(host *Host, dataDir string) *TaskWaitRegistry {
	filePath := ""
	if trimmed := strings.TrimSpace(dataDir); trimmed != "" {
		filePath = filepath.Join(trimmed, taskWaitsFileName)
	}
	reg := &TaskWaitRegistry{
		host:            host,
		filePath:        filePath,
		notifyCh:        make(chan struct{}, 1),
		subs:            map[string]TaskWaitSubscription{},
		subCtrl:         map[string]*subControl{},
		retryFailures:   map[string]int{},
		nextAttemptAt:   map[string]time.Time{},
		pollInterval:    defaultTaskWaitPollInterval,
		dispatchTimeout: defaultSignalDispatchWait,
		backoffBase:     defaultRetryBackoffBase,
		backoffMax:      defaultRetryBackoffMax,
		// Start paused so Go server boot does not run idle SQLite polling before
		// agent-host is actually started or registers a live wait.
		paused: true,
	}
	reg.load()
	return reg
}

func taskWaitKey(canvasID, sessionID string, durableTaskID int64) string {
	return fmt.Sprintf("%s\x00%s\x00%d", strings.TrimSpace(canvasID), strings.TrimSpace(sessionID), durableTaskID)
}

func normalizeTaskIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func (r *TaskWaitRegistry) ensureControlLocked(key string) *subControl {
	if ctrl := r.subCtrl[key]; ctrl != nil {
		return ctrl
	}
	r.nextEpoch++
	ctx, cancel := context.WithCancel(context.Background())
	ctrl := &subControl{epoch: r.nextEpoch, ctx: ctx, cancel: cancel}
	r.subCtrl[key] = ctrl
	return ctrl
}

func (r *TaskWaitRegistry) removeLocked(key string) {
	delete(r.subs, key)
	delete(r.retryFailures, key)
	delete(r.nextAttemptAt, key)
	if ctrl := r.subCtrl[key]; ctrl != nil {
		ctrl.cancel()
		delete(r.subCtrl, key)
	}
}

func (r *TaskWaitRegistry) SetPollInterval(interval time.Duration) {
	if r == nil || interval <= 0 {
		return
	}
	r.mu.Lock()
	r.pollInterval = interval
	r.mu.Unlock()
}

func (r *TaskWaitRegistry) SetBackoffBase(base time.Duration) {
	if r == nil || base <= 0 {
		return
	}
	r.mu.Lock()
	r.backoffBase = base
	r.mu.Unlock()
}

func (r *TaskWaitRegistry) ConfigureEvaluator(eval TaskWaitEvaluator) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.evaluator = eval
	r.startWatcherLocked()
	r.mu.Unlock()
	r.signalWake()
}

// Register idempotently records a parked tool wait subscription and triggers an
// immediate check so already-settled tasks wake without waiting for a poll tick.
func (r *TaskWaitRegistry) Register(sub TaskWaitSubscription) error {
	if r == nil {
		return nil
	}
	sub.UserID = strings.TrimSpace(sub.UserID)
	sub.CanvasID = strings.TrimSpace(sub.CanvasID)
	sub.SessionID = strings.TrimSpace(sub.SessionID)
	sub.Signal = strings.TrimSpace(sub.Signal)
	if sub.Signal == "" {
		sub.Signal = defaultBusinessTaskSignal
	}
	sub.TaskIDs = normalizeTaskIDs(sub.TaskIDs)
	if sub.CanvasID == "" || sub.SessionID == "" || sub.DurableTaskID <= 0 || len(sub.TaskIDs) == 0 {
		return invalidArg("invalid_task_wait", "任务等待订阅参数无效")
	}

	key := taskWaitKey(sub.CanvasID, sub.SessionID, sub.DurableTaskID)
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	if existing, ok := r.subs[key]; ok {
		merged := normalizeTaskIDs(append(append([]string(nil), existing.TaskIDs...), sub.TaskIDs...))
		existing.TaskIDs = merged
		if sub.UserID != "" {
			existing.UserID = sub.UserID
		}
		if sub.Signal != "" {
			existing.Signal = sub.Signal
		}
		r.subs[key] = existing
	} else {
		if strings.TrimSpace(sub.CreatedAt) == "" {
			sub.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		sub.DeliveredTaskIDs = normalizeTaskIDs(sub.DeliveredTaskIDs)
		r.subs[key] = sub
		r.ensureControlLocked(key)
	}
	delete(r.retryFailures, key)
	delete(r.nextAttemptAt, key)
	r.paused = false
	r.saveLocked()
	r.startWatcherLocked()
	r.mu.Unlock()
	r.signalWake()
	return nil
}

// Cancel removes either a specific parked tool wait (when durableTaskID > 0) or
// all waits belonging to (canvasID, sessionID) when durableTaskID == 0,
// immediately aborting any in-flight POST /signals for cancelled subscriptions.
func (r *TaskWaitRegistry) Cancel(canvasID, sessionID string, durableTaskID int64) {
	if r == nil {
		return
	}
	canvasID = strings.TrimSpace(canvasID)
	sessionID = strings.TrimSpace(sessionID)
	r.mu.Lock()
	changed := false
	if durableTaskID > 0 {
		key := taskWaitKey(canvasID, sessionID, durableTaskID)
		if _, ok := r.subs[key]; ok {
			r.removeLocked(key)
			changed = true
		}
	} else if canvasID != "" || sessionID != "" {
		for key, sub := range r.subs {
			if (canvasID == "" || sub.CanvasID == canvasID) && (sessionID == "" || sub.SessionID == sessionID) {
				r.removeLocked(key)
				changed = true
			}
		}
	}
	if changed {
		r.saveLocked()
	}
	r.mu.Unlock()
	if changed {
		r.signalWake()
	}
}

// NotifyTaskChanged wakes the watcher immediately when a business task reaches
// a new state (completion, failure, cancellation, or materialization delivery).
func (r *TaskWaitRegistry) NotifyTaskChanged(taskID string) {
	if r == nil {
		return
	}
	taskID = strings.TrimSpace(taskID)
	r.mu.Lock()
	relevant := len(r.subs) > 0 && taskID == ""
	if !relevant && taskID != "" {
		for _, sub := range r.subs {
			for _, id := range sub.TaskIDs {
				if id == taskID {
					relevant = true
					break
				}
			}
			if relevant {
				break
			}
		}
	}
	if relevant {
		r.startWatcherLocked()
	}
	r.mu.Unlock()
	if relevant {
		r.signalWake()
	}
}

// List returns a deterministic snapshot of currently active wait subscriptions.
func (r *TaskWaitRegistry) List() []TaskWaitSubscription {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	out := make([]TaskWaitSubscription, 0, len(r.subs))
	for _, sub := range r.subs {
		copied := sub
		copied.TaskIDs = append([]string(nil), sub.TaskIDs...)
		copied.DeliveredTaskIDs = append([]string(nil), sub.DeliveredTaskIDs...)
		out = append(out, copied)
	}
	r.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].CanvasID != out[j].CanvasID {
			return out[i].CanvasID < out[j].CanvasID
		}
		if out[i].SessionID != out[j].SessionID {
			return out[i].SessionID < out[j].SessionID
		}
		return out[i].DurableTaskID < out[j].DurableTaskID
	})
	return out
}

// Resume restarts watching persisted subscriptions after the host child starts.
func (r *TaskWaitRegistry) Resume() {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.paused = false
	for key := range r.subs {
		delete(r.retryFailures, key)
		delete(r.nextAttemptAt, key)
	}
	r.startWatcherLocked()
	r.mu.Unlock()
	r.signalWake()
}

// Pause stops the background watcher goroutine while preserving persisted waits.
func (r *TaskWaitRegistry) Pause() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.paused = true
	cancel := r.cancelWatch
	done := r.watchDone
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

// Stop permanently shuts down the background watcher goroutine on host close.
func (r *TaskWaitRegistry) Stop() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.closed = true
	r.paused = true
	cancel := r.cancelWatch
	done := r.watchDone
	for _, ctrl := range r.subCtrl {
		ctrl.cancel()
	}
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (r *TaskWaitRegistry) signalWake() {
	select {
	case r.notifyCh <- struct{}{}:
	default:
	}
}

func (r *TaskWaitRegistry) startWatcherLocked() {
	if r.closed || r.paused || r.watching || r.evaluator == nil || len(r.subs) == 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	r.watching = true
	r.cancelWatch = cancel
	r.watchDone = done
	interval := r.pollInterval
	if interval <= 0 {
		interval = defaultTaskWaitPollInterval
	}
	go r.watchLoop(ctx, done, interval)
}

func (r *TaskWaitRegistry) watchLoop(ctx context.Context, done chan struct{}, interval time.Duration) {
	defer func() {
		r.mu.Lock()
		if r.watchDone == done {
			r.watching = false
			r.cancelWatch = nil
			r.watchDone = nil
		}
		r.mu.Unlock()
		close(done)
	}()

	for {
		nextWait := r.sweep(ctx)
		r.mu.Lock()
		shouldExit := r.closed || r.paused || r.evaluator == nil || len(r.subs) == 0
		if shouldExit && r.watchDone == done {
			r.watching = false
			r.cancelWatch = nil
			r.watchDone = nil
			r.mu.Unlock()
			return
		}
		waitFor := r.pollInterval
		if waitFor <= 0 {
			waitFor = interval
		}
		if nextWait > 0 && nextWait < waitFor {
			waitFor = nextWait
		}
		r.mu.Unlock()

		timer := time.NewTimer(waitFor)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-r.notifyCh:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
		}
	}
}

type pendingSignalCheck struct {
	key     string
	epoch   uint64
	subCtx  context.Context
	sub     TaskWaitSubscription
	taskIDs []string
}

func (r *TaskWaitRegistry) isCurrentEpoch(key string, epoch uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ctrl := r.subCtrl[key]
	_, exists := r.subs[key]
	return exists && ctrl != nil && ctrl.epoch == epoch
}

func (r *TaskWaitRegistry) sweep(ctx context.Context) time.Duration {
	if ctx.Err() != nil {
		return 0
	}
	now := time.Now().UTC()
	var earliestRetry time.Time
	r.mu.Lock()
	eval := r.evaluator
	timeout := r.dispatchTimeout
	if timeout <= 0 {
		timeout = defaultSignalDispatchWait
	}
	pruned := false
	checks := make([]pendingSignalCheck, 0, len(r.subs))
	for key, sub := range r.subs {
		if createdAt, err := time.Parse(time.RFC3339Nano, sub.CreatedAt); err == nil && now.Sub(createdAt) > taskWaitMaxAge {
			r.removeLocked(key)
			pruned = true
			continue
		}
		delivered := make(map[string]bool, len(sub.DeliveredTaskIDs))
		for _, id := range sub.DeliveredTaskIDs {
			delivered[id] = true
		}
		pending := make([]string, 0, len(sub.TaskIDs))
		for _, id := range sub.TaskIDs {
			if !delivered[id] {
				pending = append(pending, id)
			}
		}
		if len(pending) == 0 {
			r.removeLocked(key)
			pruned = true
			continue
		}
		if nextAt, ok := r.nextAttemptAt[key]; ok && now.Before(nextAt) {
			if earliestRetry.IsZero() || nextAt.Before(earliestRetry) {
				earliestRetry = nextAt
			}
			continue
		}
		ctrl := r.ensureControlLocked(key)
		checks = append(checks, pendingSignalCheck{
			key:     key,
			epoch:   ctrl.epoch,
			subCtx:  ctrl.ctx,
			sub:     sub,
			taskIDs: pending,
		})
	}
	if pruned {
		r.saveLocked()
	}
	r.mu.Unlock()

	if eval != nil && len(checks) > 0 {
		for _, item := range checks {
			if ctx.Err() != nil {
				return 0
			}
			for _, taskID := range item.taskIDs {
				if ctx.Err() != nil {
					return 0
				}
				if item.subCtx.Err() != nil || !r.isCurrentEpoch(item.key, item.epoch) {
					goto nextSub
				}
				callCtx, callCancel := context.WithCancel(ctx)
				stopSubWatch := context.AfterFunc(item.subCtx, callCancel)
				result, err := eval(callCtx, item.sub.UserID, taskID)
				if err != nil {
					stopSubWatch()
					callCancel()
					continue
				}
				payload := result.Payload
				if result.NotFound {
					payload = map[string]any{
						"taskId": taskID,
						"status": "failed",
						"state":  "failed",
						"reason": "task_not_found",
					}
				} else if !result.Settled {
					stopSubWatch()
					callCancel()
					continue
				}
				if payload == nil {
					payload = map[string]any{"taskId": taskID}
				}

				// Final epoch check right before HTTP dispatch so Cancel cannot be raced.
				if item.subCtx.Err() != nil || !r.isCurrentEpoch(item.key, item.epoch) {
					stopSubWatch()
					callCancel()
					goto nextSub
				}
				outcome := r.dispatchSignal(callCtx, timeout, item.sub, taskID, payload)
				stopSubWatch()
				callCancel()

				if item.subCtx.Err() != nil {
					goto nextSub
				}
				switch outcome {
				case signalDelivered:
					r.markDelivered(item.key, item.epoch, taskID)
				case signalDropSubscription:
					r.dropSubscription(item.key, item.epoch)
					goto nextSub
				case signalRetryLater:
					if nextAt := r.recordRetryFailure(item.key, item.epoch, time.Now().UTC()); !nextAt.IsZero() {
						if earliestRetry.IsZero() || nextAt.Before(earliestRetry) {
							earliestRetry = nextAt
						}
					}
					goto nextSub
				}
			}
		nextSub:
		}
	}

	if earliestRetry.IsZero() {
		return 0
	}
	if wait := time.Until(earliestRetry); wait > 0 {
		return wait
	}
	return time.Millisecond
}

type signalDispatchOutcome int

const (
	signalRetryLater signalDispatchOutcome = iota
	signalDelivered
	signalDropSubscription
)

func isPermanentSignalHTTPStatus(code int) bool {
	switch code {
	case http.StatusBadRequest,
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
		http.StatusConflict,
		http.StatusUnprocessableEntity:
		return true
	default:
		return false
	}
}

func (r *TaskWaitRegistry) dispatchSignal(
	ctx context.Context,
	timeout time.Duration,
	sub TaskWaitSubscription,
	taskID string,
	value map[string]any,
) signalDispatchOutcome {
	if r.host == nil || ctx.Err() != nil {
		return signalRetryLater
	}
	body, err := json.Marshal(map[string]any{
		"canvasId":      sub.CanvasID,
		"sessionId":     sub.SessionID,
		"durableTaskId": sub.DurableTaskID,
		"signal":        sub.Signal,
		"key":           taskID,
		"value":         value,
	})
	if err != nil {
		return signalDropSubscription
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := r.host.NewChildRequest(reqCtx, http.MethodPost, "/signals", bytes.NewReader(body))
	if err != nil {
		return signalRetryLater
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.host.HTTPClient(timeout).Do(req)
	if err != nil {
		return signalRetryLater
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var parsed struct {
			OK     *bool  `json:"ok"`
			Result string `json:"result"`
		}
		if json.Unmarshal(respBody, &parsed) == nil {
			res := strings.ToLower(strings.TrimSpace(parsed.Result))
			if res == "closed" || res == "not_found" || (parsed.OK != nil && !*parsed.OK) {
				return signalDropSubscription
			}
		}
		return signalDelivered
	}
	if isPermanentSignalHTTPStatus(resp.StatusCode) {
		return signalDropSubscription
	}
	// Retry only transient 408 / 429 / 5xx (and unexpected non-permanent responses).
	return signalRetryLater
}

func (r *TaskWaitRegistry) recordRetryFailure(key string, epoch uint64, now time.Time) time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	ctrl := r.subCtrl[key]
	if ctrl == nil || ctrl.epoch != epoch {
		return time.Time{}
	}
	if _, ok := r.subs[key]; !ok {
		return time.Time{}
	}
	failures := r.retryFailures[key] + 1
	r.retryFailures[key] = failures
	base := r.backoffBase
	if base <= 0 {
		base = defaultRetryBackoffBase
	}
	capDelay := r.backoffMax
	if capDelay <= 0 {
		capDelay = defaultRetryBackoffMax
	}
	shift := failures - 1
	if shift > 10 {
		shift = 10
	}
	delay := base << shift
	if delay <= 0 || delay > capDelay {
		delay = capDelay
	}
	nextAt := now.Add(delay)
	r.nextAttemptAt[key] = nextAt
	return nextAt
}

func (r *TaskWaitRegistry) markDelivered(key string, epoch uint64, taskID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ctrl := r.subCtrl[key]
	if ctrl == nil || ctrl.epoch != epoch {
		return
	}
	sub, ok := r.subs[key]
	if !ok {
		return
	}
	delete(r.retryFailures, key)
	delete(r.nextAttemptAt, key)
	sub.DeliveredTaskIDs = normalizeTaskIDs(append(sub.DeliveredTaskIDs, taskID))
	delivered := make(map[string]bool, len(sub.DeliveredTaskIDs))
	for _, id := range sub.DeliveredTaskIDs {
		delivered[id] = true
	}
	allDone := true
	for _, id := range sub.TaskIDs {
		if !delivered[id] {
			allDone = false
			break
		}
	}
	if allDone {
		r.removeLocked(key)
	} else {
		r.subs[key] = sub
	}
	r.saveLocked()
}

func (r *TaskWaitRegistry) dropSubscription(key string, epoch uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ctrl := r.subCtrl[key]
	if ctrl == nil || ctrl.epoch != epoch {
		return
	}
	if _, ok := r.subs[key]; !ok {
		return
	}
	r.removeLocked(key)
	r.saveLocked()
}

func (r *TaskWaitRegistry) load() {
	if r.filePath == "" {
		return
	}
	raw, err := os.ReadFile(r.filePath)
	if err != nil {
		return
	}
	var items []TaskWaitSubscription
	if err := json.Unmarshal(raw, &items); err != nil {
		return
	}
	now := time.Now().UTC()
	for _, item := range items {
		item.CanvasID = strings.TrimSpace(item.CanvasID)
		item.SessionID = strings.TrimSpace(item.SessionID)
		item.TaskIDs = normalizeTaskIDs(item.TaskIDs)
		item.DeliveredTaskIDs = normalizeTaskIDs(item.DeliveredTaskIDs)
		if item.Signal == "" {
			item.Signal = defaultBusinessTaskSignal
		}
		if item.CanvasID == "" || item.SessionID == "" || item.DurableTaskID <= 0 || len(item.TaskIDs) == 0 {
			continue
		}
		if createdAt, parseErr := time.Parse(time.RFC3339Nano, item.CreatedAt); parseErr == nil && now.Sub(createdAt) > taskWaitMaxAge {
			continue
		}
		key := taskWaitKey(item.CanvasID, item.SessionID, item.DurableTaskID)
		r.subs[key] = item
		r.ensureControlLocked(key)
	}
}

func (r *TaskWaitRegistry) saveLocked() {
	if r.filePath == "" {
		return
	}
	if len(r.subs) == 0 {
		_ = os.Remove(r.filePath)
		return
	}
	items := make([]TaskWaitSubscription, 0, len(r.subs))
	for _, sub := range r.subs {
		items = append(items, sub)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CanvasID != items[j].CanvasID {
			return items[i].CanvasID < items[j].CanvasID
		}
		if items[i].SessionID != items[j].SessionID {
			return items[i].SessionID < items[j].SessionID
		}
		return items[i].DurableTaskID < items[j].DurableTaskID
	})
	raw, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return
	}
	dir := filepath.Dir(r.filePath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, taskWaitsFileName+".*.tmp")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return
	}
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, os.ErrPermission) {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return
	}
	if err := os.Rename(tmpPath, r.filePath); err != nil {
		_ = os.Remove(tmpPath)
	}
}
