package asset

import (
	"bytes"
	"errors"
	"fmt"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// StoreDeliverable persists an assistant-generated or script-generated file as
// an owned local Resource using the existing FileStore and quota checks.
func StoreDeliverable(
	repo *repository.Repository,
	dataDir, userID, uploadKey, fileName, mimeType string,
	content []byte,
	generatedLimitMB, storedLimitGB, dailyUploadLimitMB int64,
) (*model.Resource, error) {
	if repo == nil || dataDir == "" {
		return nil, kernel.NewAppError(500, "本地文件存储暂不可用")
	}
	if existing, err := repo.ResourceByUploadKey(userID, uploadKey); err == nil {
		if existing.Status == model.ResourceStatusReady {
			return existing, nil
		}
		return nil, kernel.NewAppError(409, "文件正在保存，请稍候重试")
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	size := int64(len(content))
	if generatedLimitMB > 0 && size > generatedLimitMB*(1<<20) {
		return nil, kernel.BadAuthRequest(fmt.Sprintf("文件不能超过 %dMB", generatedLimitMB))
	}
	if storedLimitGB > 0 {
		stored, err := repo.UserStoredFileBytes(userID)
		if err != nil {
			return nil, err
		}
		if stored+size >= storedLimitGB*(1<<30) {
			return nil, kernel.NewAppError(429, "文件超过工作区存储额度")
		}
	}
	if dailyUploadLimitMB > 0 && size > 0 {
		day := time.Now().UTC().Format("2006-01-02")
		if err := repo.ReserveIdentifiedDailyUpload(userID, day, uploadKey, size, dailyUploadLimitMB*(1<<20)); err != nil {
			if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
				return nil, kernel.NewAppError(429, "文件超过今日保存额度")
			}
			return nil, err
		}
	}
	svc := NewService(Dependencies{
		Repository:   NewRepository(repo),
		Blobs:        NewFileStore(dataDir),
		LocalStorage: true,
	})
	resource, _, err := svc.Store(userID, "file", fileName, mimeType, size, 0, 0, 0, bytes.NewReader(content), &uploadKey)
	return resource, err
}
