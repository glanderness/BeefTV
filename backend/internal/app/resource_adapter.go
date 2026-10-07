package app

import (
	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// resourceQuota and resourceLifecycle are typed adapters so the asset domain
// does not receive Service method values as callbacks.
type resourceQuota struct {
	svc *Service
}

func (q resourceQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveUserUploadQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveChunkedUploadQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveRetryUploadQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveGeneratedResourceQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveRetryGeneratedQuotaFor(userID, size, identity)
}

func (q resourceQuota) Release(userID string, day string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.releaseUserUploadQuotaFor(userID, day, size, identity)
}

func (q resourceQuota) ReleaseRetry(userID string, day string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.releaseRetryUploadQuotaFor(userID, day, size, identity)
}

func (q resourceQuota) Commit(userID string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.commitUserUploadQuotaFor(userID, size, identity)
}

type resourceLifecycle struct {
	svc *Service
}

func (l resourceLifecycle) RecordActivity(userID string, kind string, count int) {
	if l.svc == nil {
		return
	}
	l.svc.recordActivity(userID, kind, count)
}

func (l resourceLifecycle) AfterResourceReady(resource *model.Resource) {
	if l.svc == nil {
		return
	}
	l.svc.playbackRuntime().MaybeStart(resource)
}

func (l resourceLifecycle) AppearanceReferencedIDs(resourceIDs []string) map[string]struct{} {
	if l.svc == nil {
		return map[string]struct{}{}
	}
	return l.svc.appearanceReferencedResourceIDs(resourceIDs)
}

func (l resourceLifecycle) RecycleRetentionDays() (int, error) {
	if l.svc == nil {
		return 0, nil
	}
	policy, err := l.svc.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return policy.Resource.RecycleBinRetentionDays, nil
}

func (l resourceLifecycle) WorkerID() string {
	if l.svc == nil {
		return ""
	}
	return l.svc.workerID
}

func (l resourceLifecycle) RunBackground(fn func()) {
	if l.svc == nil || fn == nil {
		return
	}
	l.svc.runWorkerTask(fn)
}

func (l resourceLifecycle) DeleteUserAsset(userID string, assetID string) error {
	if l.svc == nil {
		return nil
	}
	return l.svc.DeleteUserAsset(userID, assetID)
}

func (l resourceLifecycle) WithStorageLock(fn func() error) error {
	if l.svc == nil {
		if fn == nil {
			return nil
		}
		return fn()
	}
	l.svc.storageMu.Lock()
	defer l.svc.storageMu.Unlock()
	return fn()
}

// txResourceQuota 是配额端口的事务连接版：操作层写事务持有桌面库唯一连接，
// 配额的策略读取、用量预留与释放都必须走同一条连接，否则互相等待直到超时。
type txResourceQuota struct {
	svc  *Service
	repo *repository.Repository
}

func (q txResourceQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveUserUploadQuotaForWithRepo(q.repo, userID, size, identity)
}

func (q txResourceQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveChunkedUploadQuotaForWithRepo(q.repo, userID, size, identity)
}

func (q txResourceQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveRetryUploadQuotaForWithRepo(q.repo, userID, size, identity)
}

func (q txResourceQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveGeneratedResourceQuotaForWithRepo(q.repo, userID, size, identity)
}

func (q txResourceQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveRetryGeneratedQuotaForWithRepo(q.repo, userID, size, identity)
}

func (q txResourceQuota) Release(userID string, day string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.releaseUserUploadQuotaForWithRepo(q.repo, userID, day, size, identity)
}

func (q txResourceQuota) ReleaseRetry(userID string, day string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.releaseRetryUploadQuotaForWithRepo(q.repo, userID, day, size, identity)
}

func (q txResourceQuota) Commit(userID string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.commitUserUploadQuotaForWithRepo(q.repo, userID, size, identity)
}

var _ localasset.Quota = txResourceQuota{}
