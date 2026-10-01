package asset

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"sync"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

type ResourceStream = assets.ResourceStream
type ResourceDeliveryOptions = assets.ResourceDeliveryOptions
type ResourceDelivery = assets.ResourceDelivery

// Service owns durable local resource rules.
type Service struct {
	repo         Repository
	blobs        BlobStore
	quota        Quota
	lifecycle    Lifecycle
	localStorage bool
	uploadLocks  sync.Map
}

func NewService(deps Dependencies) *Service {
	return &Service{
		repo:         deps.Repository,
		blobs:        deps.Blobs,
		quota:        deps.Quota,
		lifecycle:    deps.Lifecycle,
		localStorage: deps.LocalStorage,
	}
}

func (s *Service) lockUploadKey(key *string) func() {
	if s == nil || key == nil || *key == "" {
		return func() {}
	}
	value, _ := s.uploadLocks.LoadOrStore(*key, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	lock.Lock()
	return lock.Unlock
}

func (s *Service) Resources(userID string, limit int) ([]model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resources, err := s.repo.Resources(userID, limit)
	if err != nil {
		return nil, err
	}
	for index := range resources {
		resources[index].PublicURL = ""
		if err := s.validateListedResource(&resources[index]); err != nil {
			return nil, err
		}
	}
	return resources, nil
}

func (s *Service) Resource(userID string, id string) (*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if resource != nil {
		resource.PublicURL = ""
	}
	return resource, err
}

func (s *Service) validateListedResource(resource *model.Resource) error {
	if resource == nil || !s.localStorage {
		return nil
	}
	if resource.Provider != "local" {
		return fmt.Errorf("资源 %s 不属于本地存储", resource.ID)
	}
	if resource.Status != model.ResourceStatusReady {
		return nil
	}
	if s.blobs == nil {
		return fmt.Errorf("资源 %s 的本地文件缺失", resource.ID)
	}
	if err := s.blobs.Exists(resource.ObjectKey); err != nil {
		return fmt.Errorf("资源 %s 的本地文件缺失", resource.ID)
	}
	return nil
}

func (s *Service) Upload(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.upload(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) UploadLocal(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.upload(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) upload(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	if header == nil {
		return nil, MissingUpload()
	}
	uploadKey := NormalizedUploadKey(uploadIdentity)
	unlock := s.lockUploadKey(uploadKey)
	defer unlock()
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	file, err := header.Open()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	mimeType := DetectUploadedMimeType(file, header.Filename, header.Header.Get("Content-Type"))
	if existing != nil {
		return s.Retry(userID, existing, kind, mimeType, header.Size, file)
	}
	day, err := s.reserveUpload(userID, header.Size)
	if err != nil {
		return nil, err
	}
	resource, stored, err := s.Store(userID, kind, header.Filename, mimeType, header.Size, width, height, durationMs, file, uploadKey)
	s.finishQuota(userID, day, header.Size, stored, err)
	return resource, err
}

func (s *Service) UploadFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadFile(userID, fileName, size, kind, width, height, durationMs, file, uploadIdentity...)
}

func (s *Service) UploadLocalFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadFile(userID, fileName, size, kind, width, height, durationMs, file, uploadIdentity...)
}

func (s *Service) uploadFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	if file == nil || size <= 0 {
		return nil, MissingUpload()
	}
	uploadKey := NormalizedUploadKey(uploadIdentity)
	unlock := s.lockUploadKey(uploadKey)
	defer unlock()
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	mimeType := DetectUploadedMimeType(file, fileName, "")
	if existing != nil {
		return s.Retry(userID, existing, kind, mimeType, size, file)
	}
	day, err := s.reserveChunked(userID, size)
	if err != nil {
		return nil, err
	}
	resource, stored, err := s.Store(userID, kind, fileName, mimeType, size, width, height, durationMs, file, uploadKey)
	s.finishQuota(userID, day, size, stored, err)
	return resource, err
}

func (s *Service) reserveUpload(userID string, size int64) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return s.quota.ReserveUpload(userID, size)
}

func (s *Service) reserveChunked(userID string, size int64) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return s.quota.ReserveChunked(userID, size)
}

func (s *Service) finishQuota(userID string, day string, size int64, stored bool, err error) {
	if s == nil || s.quota == nil {
		return
	}
	if err != nil {
		s.quota.Release(userID, day, size)
		return
	}
	if stored {
		s.quota.Commit(userID, size)
		return
	}
	s.quota.Release(userID, day, size)
}

func (s *Service) resourceForUploadKey(userID string, uploadKey *string) (*model.Resource, error) {
	if uploadKey == nil || s == nil || s.repo == nil {
		return nil, nil
	}
	resource, err := s.repo.ResourceByUploadKey(userID, *uploadKey)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return resource, nil
}

func (s *Service) afterReady(resource *model.Resource) {
	if s == nil || s.lifecycle == nil || resource == nil {
		return
	}
	s.lifecycle.RecordActivity(resource.UserID, "resource", 1)
	s.lifecycle.AfterResourceReady(resource)
}

func (s *Service) workerID() string {
	if s != nil && s.lifecycle != nil {
		if id := s.lifecycle.WorkerID(); id != "" {
			return id
		}
	}
	return kernel.NewID()
}

func (s *Service) runBackground(fn func()) {
	if s == nil || s.lifecycle == nil || fn == nil {
		return
	}
	s.lifecycle.RunBackground(fn)
}
