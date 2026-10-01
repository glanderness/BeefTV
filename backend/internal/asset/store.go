package asset

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// Store creates a pending row, publishes bytes through FileStore, then marks
// READY. A failed READY write leaves FAILED (or PENDING if status cannot be
// saved) with bytes on disk so the same upload key can recover. READY is never
// recorded without a successful metadata save after a successful file write.
func (s *Service) Store(userID string, kind string, fileName string, mimeType string, size int64, width int, height int, durationMs int64, body io.Reader, uploadKey *string) (*model.Resource, bool, error) {
	if s == nil || s.repo == nil {
		return nil, false, ResourceMissing()
	}
	if existing, err := s.resourceForUploadKey(userID, uploadKey); err != nil {
		return nil, false, err
	} else if existing != nil {
		if existing.Status == model.ResourceStatusReady {
			return existing, false, nil
		}
		return nil, false, UploadInProgress()
	}
	now := time.Now()
	kind = NormalizeKind(kind, mimeType)
	objectKey := ObjectKey(userID, kind, fileName, mimeType, now)
	resource := model.Resource{
		ID: kernel.NewID(), UserID: userID, Kind: kind, Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: objectKey, MimeType: mimeType, Size: size,
		Width: width, Height: height, DurationMs: durationMs, UploadKey: uploadKey,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.CreateResource(&resource); err != nil {
		if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr == nil && existing != nil {
			if existing.Status == model.ResourceStatusReady {
				return existing, false, nil
			}
			return nil, false, UploadInProgress()
		}
		return nil, false, err
	}
	etag, err := s.WriteObject(&resource, fileName, body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		resource.Status = model.ResourceStatusFailed
		resource.Error = err.Error()
		if saveErr := s.repo.SaveResource(&resource); saveErr != nil {
			return &resource, true, errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", saveErr))
		}
		return &resource, true, err
	}
	resource.Status = model.ResourceStatusReady
	resource.ETag = etag
	if err := s.repo.SaveResource(&resource); err != nil {
		resource.Status = model.ResourceStatusFailed
		resource.Error = fmt.Sprintf("保存资源就绪状态失败：%v", err)
		if statusErr := s.repo.SaveResource(&resource); statusErr != nil {
			return &resource, true, errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", statusErr))
		}
		return &resource, true, fmt.Errorf("保存资源就绪状态失败：%w", err)
	}
	s.afterReady(&resource)
	return &resource, true, nil
}

func (s *Service) WriteObject(resource *model.Resource, fileName string, body io.Reader) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	if s == nil || s.blobs == nil {
		return "", errors.New("local resource store is not initialized")
	}
	resource.Provider = "local"
	resource.Endpoint = ""
	resource.Bucket = ""
	resource.StorageSettingID = ""
	resource.ETag = ""
	if strings.TrimSpace(resource.ObjectKey) == "" {
		resource.ObjectKey = ObjectKey(resource.UserID, resource.Kind, fileName, resource.MimeType, time.Now())
	}
	return "", s.blobs.Write(resource.ObjectKey, body)
}

// Retry completes a FAILED or leftover PENDING upload under the same identity.
func (s *Service) Retry(userID string, resource *model.Resource, kind string, mimeType string, size int64, body io.Reader) (*model.Resource, error) {
	if resource == nil {
		return nil, errors.New("资源不存在")
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if resource.Status == model.ResourceStatusFailed {
		if s == nil || s.repo == nil {
			return nil, ResourceMissing()
		}
		claimed, err := s.repo.ClaimFailedResourceUpload(userID, resource.ID)
		if err != nil {
			return nil, err
		}
		if !claimed {
			latest, latestErr := s.repo.ResourceForUser(userID, resource.ID)
			if latestErr == nil && latest != nil && latest.Status == model.ResourceStatusReady {
				return latest, nil
			}
			return nil, UploadInProgress()
		}
	} else if resource.Status != model.ResourceStatusPending {
		return nil, UploadInProgress()
	}
	kind = NormalizeKind(kind, mimeType)
	if resource.Size != size || resource.Kind != kind || (resource.MimeType != "" && mimeType != "" && resource.MimeType != mimeType) {
		return nil, UploadConflict()
	}
	if resource.Provider != "local" {
		resource.Provider = "local"
		resource.Endpoint = ""
		resource.Bucket = ""
		resource.StorageSettingID = ""
		resource.ObjectKey = ObjectKey(userID, kind, "", mimeType, time.Now())
	}
	resource.Status = model.ResourceStatusPending
	resource.Error = ""
	resource.UpdatedAt = time.Now()
	day, err := s.reserveRetry(userID, size)
	if err != nil {
		resource.Status = model.ResourceStatusFailed
		resource.Error = err.Error()
		resource.UpdatedAt = time.Now()
		if saveErr := s.repo.SaveResource(resource); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("恢复资源重试失败状态失败：%w", saveErr))
		}
		return nil, err
	}
	etag, err := s.WriteObject(resource, "", body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		s.releaseRetry(userID, day, size)
		resource.Status = model.ResourceStatusFailed
		resource.Error = err.Error()
		if saveErr := s.repo.SaveResource(resource); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("记录资源重试失败状态失败：%w", saveErr))
		}
		return nil, err
	}
	resource.Status = model.ResourceStatusReady
	resource.ETag = etag
	if err := s.repo.SaveResource(resource); err != nil {
		s.releaseRetry(userID, day, size)
		resource.Status = model.ResourceStatusFailed
		resource.Error = "保存资源重试就绪状态失败"
		if saveErr := s.repo.SaveResource(resource); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("记录资源重试失败状态失败：%w", saveErr))
		}
		return nil, fmt.Errorf("保存资源重试就绪状态失败：%w", err)
	}
	s.afterReady(resource)
	return resource, nil
}

func (s *Service) reserveRetry(userID string, size int64) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return s.quota.ReserveRetry(userID, size)
}

func (s *Service) releaseRetry(userID string, day string, size int64) {
	if s == nil || s.quota == nil {
		return
	}
	s.quota.ReleaseRetry(userID, day, size)
}
