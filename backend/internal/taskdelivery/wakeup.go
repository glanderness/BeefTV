package taskdelivery

import (
	"context"
	"sync"
	"time"
)

// RecoveryWakeup coalesces asynchronous recovery wakeups into a single-buffered
// channel so background recovery stays idle until work arrives or the safety-net
// interval fires.
type RecoveryWakeup struct {
	mu sync.Mutex
	ch chan struct{}
}

func (w *RecoveryWakeup) channel() chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ch == nil {
		w.ch = make(chan struct{}, 1)
	}
	return w.ch
}

func (w *RecoveryWakeup) Signal() {
	if w == nil {
		return
	}
	ch := w.channel()
	select {
	case ch <- struct{}{}:
	default:
	}
}

// RunSplitLoops decouples fast active-provider/continuation polling (5s) from
// the event-driven delivery/bind outbox safety-net cadence (30s + Signal).
func (w *RecoveryWakeup) RunSplitLoops(
	ctx context.Context,
	fastInterval time.Duration,
	slowInterval time.Duration,
	skip func() bool,
	fastStep func(),
	slowStep func(),
) {
	run := func(step func()) {
		if step == nil || ctx.Err() != nil || (skip != nil && skip()) {
			return
		}
		step()
	}
	run(fastStep)
	run(slowStep)
	if slowInterval <= 0 {
		slowInterval = GenerationDeliveryRecoveryInterval
	}
	ch := w.channel()
	slowTicker := time.NewTicker(slowInterval)
	defer slowTicker.Stop()

	var fastC <-chan time.Time
	if fastStep != nil && fastInterval > 0 {
		fastTicker := time.NewTicker(fastInterval)
		defer fastTicker.Stop()
		fastC = fastTicker.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			run(slowStep)
		case <-fastC:
			run(fastStep)
		case <-slowTicker.C:
			run(slowStep)
		}
	}
}
