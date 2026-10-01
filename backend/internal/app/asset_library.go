package app

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

type CreateAssetFolderRequest struct {
	Name string `json:"name"`
}

type UpdateAssetFolderRequest struct {
	Name string `json:"name"`
}

type MoveUserAssetsRequest struct {
	AssetIDs []string `json:"assetIds"`
	FolderID string   `json:"folderId"`
}

func (s *Service) AssetFolders(userID string) ([]model.AssetFolder, error) {
	return s.repo.AssetFolders(userID)
}

func (s *Service) CreateAssetFolder(userID string, req CreateAssetFolderRequest) (model.AssetFolder, error) {
	name, nameKey, err := normalizeAssetFolderName(req.Name)
	if err != nil {
		return model.AssetFolder{}, err
	}
	exists, err := s.repo.AssetFolderNameExists(userID, nameKey, "")
	if err != nil {
		return model.AssetFolder{}, err
	}
	if exists {
		return model.AssetFolder{}, BadAuthRequest("已存在同名素材分类")
	}
	position, err := s.repo.NextAssetFolderPosition(userID)
	if err != nil {
		return model.AssetFolder{}, err
	}
	now := time.Now().UTC()
	folder := model.AssetFolder{ID: newID(), UserID: userID, Name: name, NameKey: nameKey, Position: position, CreatedAt: now, UpdatedAt: now}
	if err := s.repo.CreateAssetFolder(&folder); err != nil {
		return model.AssetFolder{}, err
	}
	return folder, nil
}

func (s *Service) UpdateAssetFolder(userID string, folderID string, req UpdateAssetFolderRequest) (model.AssetFolder, error) {
	folder, err := s.repo.AssetFolderForUser(userID, strings.TrimSpace(folderID))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.AssetFolder{}, BadAuthRequest("素材分类不存在")
		}
		return model.AssetFolder{}, err
	}
	name, nameKey, err := normalizeAssetFolderName(req.Name)
	if err != nil {
		return model.AssetFolder{}, err
	}
	exists, err := s.repo.AssetFolderNameExists(userID, nameKey, folder.ID)
	if err != nil {
		return model.AssetFolder{}, err
	}
	if exists {
		return model.AssetFolder{}, BadAuthRequest("已存在同名素材分类")
	}
	folder.Name = name
	folder.NameKey = nameKey
	folder.UpdatedAt = time.Now().UTC()
	if err := s.repo.UpdateAssetFolder(folder); err != nil {
		return model.AssetFolder{}, err
	}
	return *folder, nil
}

func (s *Service) DeleteAssetFolder(userID string, folderID string) error {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	err := s.repo.DeleteAssetFolder(userID, strings.TrimSpace(folderID))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return BadAuthRequest("素材分类不存在")
	}
	return err
}

func (s *Service) MoveUserAssetsToFolder(userID string, req MoveUserAssetsRequest) error {
	ids := uniqueNonemptyStrings(req.AssetIDs)
	if len(ids) == 0 {
		return BadAuthRequest("请选择要移动的素材")
	}
	if len(ids) > 200 {
		return BadAuthRequest("一次最多移动 200 个素材")
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	folderID := strings.TrimSpace(req.FolderID)
	if folderID != "" {
		if _, err := s.repo.AssetFolderForUser(userID, folderID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return BadAuthRequest("目标素材分类不存在")
			}
			return err
		}
	}
	if err := s.repo.MoveUserAssetsToFolder(userID, ids, folderID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return BadAuthRequest("部分素材不存在或不属于当前用户")
		}
		return err
	}
	return nil
}

func normalizeAssetFolderName(value string) (string, string, error) {
	name := strings.TrimSpace(value)
	if name == "" {
		return "", "", BadAuthRequest("请输入素材分类名称")
	}
	if utf8.RuneCountInString(name) > 40 {
		return "", "", BadAuthRequest("素材分类名称不能超过 40 个字符")
	}
	return name, strings.ToLower(name), nil
}

func uniqueNonemptyStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
