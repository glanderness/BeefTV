package platform

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestNewLocalCoordinatorIgnoresRedisEnvironment(t *testing.T) {
	t.Setenv("REDIS_URL", "redis://127.0.0.1:1")
	coordinator := NewLocalCoordinator()
	allowed, err := coordinator.Allow(context.Background(), "local", 1, time.Minute)
	if err != nil || !allowed {
		t.Fatalf("local coordinator rate limit = allowed:%v err:%v", allowed, err)
	}
}

func TestRuntimeCoordinatorLeaseRenewsAndCannotResurrect(t *testing.T) {
	c := &Coordinator{instanceID: "test", localSlots: map[string]map[string]time.Time{}}
	lease, acquired, err := c.AcquireLease(context.Background(), "workers", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("acquire: %v %v", acquired, err)
	}
	c.localSlots["workers"][lease.Token()] = time.Now().Add(10 * time.Second)
	if err := lease.Renew(context.Background()); err != nil {
		t.Fatal(err)
	}
	if time.Until(c.localSlots["workers"][lease.Token()]) < 50*time.Second {
		t.Fatal("lease was not extended")
	}
	if _, ok, err := c.AcquireLease(context.Background(), "workers", 1, time.Minute); err != nil || ok {
		t.Fatalf("capacity exceeded: %v %v", ok, err)
	}
	c.localSlots["workers"][lease.Token()] = time.Now().Add(-time.Second)
	if err := lease.Renew(context.Background()); !errors.Is(err, ErrSlotLeaseLost) {
		t.Fatalf("expired lease renew err = %v, want ErrSlotLeaseLost", err)
	}
	replacement, acquired, err := c.AcquireLease(context.Background(), "workers", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("abandoned slot not recovered: %v %v", acquired, err)
	}
	lease.Release()
	lease.Release()
	if err := replacement.Renew(context.Background()); err != nil {
		t.Fatalf("old release removed new lease: %v", err)
	}
	replacement.Release()
	if len(c.localSlots) != 0 {
		t.Fatal("empty local slot scopes retained")
	}
}

func TestSlotLeaseReacquireRefreshesExpiredUntilReleased(t *testing.T) {
	c := NewLocalCoordinator()
	lease, acquired, err := c.AcquireLease(context.Background(), "workers", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("acquire: %v %v", acquired, err)
	}
	c.localMu.Lock()
	c.localSlots["workers"][lease.Token()] = time.Now().Add(-time.Minute)
	c.localMu.Unlock()

	if err := lease.Reacquire(context.Background()); err != nil {
		t.Fatalf("reacquire expired unreleased slot: %v", err)
	}
	if err := lease.Renew(context.Background()); err != nil {
		t.Fatalf("renew after reacquire: %v", err)
	}
	lease.Release()
	if err := lease.Reacquire(context.Background()); !errors.Is(err, ErrSlotLeaseLost) {
		t.Fatalf("reacquire after release err = %v, want ErrSlotLeaseLost", err)
	}
}

func TestRuntimeCoordinatorWaitsUntilChannelSlotIsReleased(t *testing.T) {
	coordinator := &Coordinator{instanceID: "test", localRate: map[string]localRateEntry{}, localSlots: map[string]map[string]time.Time{}}
	releaseFirst, acquired, err := coordinator.Acquire(context.Background(), "channel:one", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("first acquire = (%v, %v), want acquired", acquired, err)
	}

	result := make(chan error, 1)
	go func() {
		releaseSecond, waitErr := coordinator.AcquireWithWait(context.Background(), "channel:one", 1, time.Minute)
		if waitErr == nil {
			releaseSecond()
		}
		result <- waitErr
	}()

	select {
	case err := <-result:
		t.Fatalf("second acquire returned before release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	releaseFirst()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("second acquire after release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("second acquire did not resume after release")
	}
}

func TestRuntimeCoordinatorStopsWaitingWhenContextIsCancelled(t *testing.T) {
	coordinator := &Coordinator{instanceID: "test", localRate: map[string]localRateEntry{}, localSlots: map[string]map[string]time.Time{}}
	release, acquired, err := coordinator.Acquire(context.Background(), "channel:one", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("first acquire = (%v, %v), want acquired", acquired, err)
	}
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := coordinator.AcquireWithWait(ctx, "channel:one", 1, time.Minute); err == nil {
		t.Fatal("acquireWithWait() error = nil after cancellation")
	}
}

func TestChannelSlotRetryDelayStaysWithinBackoffWindow(t *testing.T) {
	for _, base := range []time.Duration{200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, 1600 * time.Millisecond, 2 * time.Second} {
		for range 100 {
			if got := channelSlotRetryDelay(base); got < base/2 || got > base {
				t.Fatalf("delay %s outside [%s, %s]", got, base/2, base)
			}
		}
	}
}
