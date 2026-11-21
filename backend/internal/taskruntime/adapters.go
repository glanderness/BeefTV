package taskruntime

import (
	"context"
	"errors"
	"fmt"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"
)

// RepositoryAdapter 把 repository.Repository 适配到 taskruntime.Repository，
// 并将底层租约失效哨兵统一映射为 taskruntime.ErrLeaseLost。
type RepositoryAdapter struct {
	repo          *repository.Repository
	singleProcess bool
}

func NewRepositoryAdapter(repo *repository.Repository, singleProcess bool) RepositoryAdapter {
	return RepositoryAdapter{repo: repo, singleProcess: singleProcess}
}

func (a RepositoryAdapter) ClaimNext(ctx context.Context, owner string, ttl time.Duration) (*model.Task, error) {
	return a.ClaimNextExcluding(ctx, owner, ttl, nil)
}

func (a RepositoryAdapter) ClaimNextExcluding(ctx context.Context, owner string, ttl time.Duration, excludeIDs []string) (*model.Task, error) {
	repo := a.repo
	if ctx != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if ctx != nil && ctx != context.Background() {
		repo = repo.WithContext(ctx)
	}
	return repo.ClaimNextTask(owner, ttl, excludeIDs...)
}

func (a RepositoryAdapter) RenewLease(ctx context.Context, taskID, owner string, ttl time.Duration) error {
	repo := a.repo.WithContext(ctx)
	var err error
	if a.singleProcess {
		err = repo.ReacquireTaskLease(taskID, owner, ttl)
	} else {
		err = repo.RenewTaskLease(taskID, owner, ttl)
	}
	if errors.Is(err, repository.ErrTaskLeaseLost) {
		return fmt.Errorf("%w: %w", ErrLeaseLost, err)
	}
	return err
}

func (a RepositoryAdapter) ReleaseLease(taskID, owner string) error {
	return a.repo.ReleaseTaskLease(taskID, owner)
}

// SlotCoordinatorAdapter 把 platform.Coordinator 适配到 taskruntime.Coordinator，
// 并将槽位租约失效统一映射为 taskruntime.ErrLeaseLost。
type SlotCoordinatorAdapter struct {
	coordinator   *platform.Coordinator
	singleProcess bool
}

func NewSlotCoordinatorAdapter(coordinator *platform.Coordinator, singleProcess bool) SlotCoordinatorAdapter {
	return SlotCoordinatorAdapter{coordinator: coordinator, singleProcess: singleProcess}
}

func (c SlotCoordinatorAdapter) AcquireLease(ctx context.Context, scope string, limit int, ttl time.Duration) (SlotLease, bool, error) {
	if c.coordinator == nil {
		return nil, false, errors.New("运行时协调器未初始化")
	}
	lease, acquired, err := c.coordinator.AcquireLease(ctx, scope, limit, ttl)
	if err != nil || !acquired {
		return nil, acquired, err
	}
	return slotLeaseAdapter{lease: lease, singleProcess: c.singleProcess}, true, nil
}

type slotLeaseAdapter struct {
	lease         *platform.SlotLease
	singleProcess bool
}

func (s slotLeaseAdapter) Token() string { return s.lease.Token() }

func (s slotLeaseAdapter) Renew(ctx context.Context) error {
	var err error
	if s.singleProcess {
		err = s.lease.Reacquire(ctx)
	} else {
		err = s.lease.Renew(ctx)
	}
	if errors.Is(err, platform.ErrSlotLeaseLost) {
		return fmt.Errorf("%w: %w", ErrLeaseLost, err)
	}
	return err
}

func (s slotLeaseAdapter) Release() { s.lease.Release() }
