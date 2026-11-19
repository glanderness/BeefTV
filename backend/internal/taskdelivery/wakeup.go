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

func (w *RecoveryWakeup) RunLoop(ctx context.Context, interval time.Duration, step func()) {
	step()
	if interval <= 0 {
		interval = GenerationDeliveryRecoveryInterval
	}
	ch := w.channel()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			step()
		case <-ticker.C:
			step()
		}
	}
}
