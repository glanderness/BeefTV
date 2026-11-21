package app

import "infinite-canvas/backend/internal/asset"

func (s *Service) fileQuota() *asset.FileQuota {
	s.fileQuotaOnce.Do(func() {
		s.fileQuotaService = asset.NewFileQuota(s.repo, func() (asset.FileQuotaPolicy, error) {
			policy, err := s.RuntimePolicy()
			return asset.FileQuotaPolicy{ResourceUploadMB: policy.Resource.ResourceUploadMB, GeneratedFileMB: policy.Resource.GeneratedFileMB, DailyUploadMB: policy.Resource.DailyUploadMB, StoredFileGB: policy.Resource.StoredFileGB, Unlimited: policy.Resource.Unlimited}, err
		}, &s.storageMu).SetUnlimited(s.IsLocalMode())
	})
	return s.fileQuotaService
}
