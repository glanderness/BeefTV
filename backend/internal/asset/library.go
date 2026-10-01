package asset

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// Host supplies encryption, quota, storage locking and physical resource
// deletion. Canvas reference guards stay on this port so Library does not
// import canvas. Callers must not implement a second deletion path.
type Host interface {
	EncryptSecret(value string) (string, error)
	DecryptSecret(value string) (string, error)
	WithStorageLock(fn func() error) error
	StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error
	StructuredReplacementQuota(userID, kind string, count int, bytes int64) error
	DeleteUserAssetWithResources(userID, assetID string) error
	RecordActivity(userID, event string, count int)
	GuardAssetCanvasReferences(userID string, asset model.Asset) error
	GuardReplacementCanvasReferences(userID string, assets []model.Asset) error
}

type nopHost struct{}

func (nopHost) EncryptSecret(value string) (string, error) { return value, nil }
func (nopHost) DecryptSecret(value string) (string, error) { return value, nil }
func (nopHost) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}
func (nopHost) StructuredQuota(string, string, bool, int64) error           { return nil }
func (nopHost) StructuredReplacementQuota(string, string, int, int64) error { return nil }
func (nopHost) DeleteUserAssetWithResources(string, string) error           { return nil }
func (nopHost) RecordActivity(string, string, int)                          {}
func (nopHost) GuardAssetCanvasReferences(string, model.Asset) error        { return nil }
func (nopHost) GuardReplacementCanvasReferences(string, []model.Asset) error {
	return nil
}

// Library owns user asset-library metadata: documents, folders, paging and
// ownership checks. Resource bytes stay on Service / FileStore.
type Library struct {
	repo *repository.Repository
	host Host
}

func NewLibrary(repo *repository.Repository, host Host) *Library {
	if host == nil {
		host = nopHost{}
	}
	return &Library{repo: repo, host: host}
}

func (l *Library) WithRepository(repo *repository.Repository) *Library {
	if l == nil {
		return NewLibrary(repo, nil)
	}
	return &Library{repo: repo, host: l.host}
}

func (l *Library) WithHost(host Host) *Library {
	if l == nil {
		return NewLibrary(nil, host)
	}
	if host == nil {
		host = nopHost{}
	}
	return &Library{repo: l.repo, host: host}
}

func (l *Library) UserAssetSummaries(userID string) ([]Summary, error) {
	assets, err := l.repo.AssetSummaries(userID)
	if err != nil {
		return nil, err
	}
	result := make([]Summary, 0, len(assets))
	for _, item := range assets {
		result = append(result, summaryFromAsset(item))
	}
	return result, nil
}

func (l *Library) UserAsset(userID string, id string) (json.RawMessage, error) {
	item, err := l.repo.AssetForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return ClientAssetPayload(*item), nil
}

func (l *Library) UserAssets(userID string) ([]json.RawMessage, error) {
	assets, err := l.repo.Assets(userID)
	if err != nil {
		return nil, err
	}
	return clientPayloads(assets), nil
}

func (l *Library) UserAssetsByIDs(userID string, ids []string) ([]json.RawMessage, error) {
	if len(ids) > 100 {
		return nil, kernel.BadAuthRequest("每次最多读取 100 个素材")
	}
	unique := make([]string, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || len(id) > 80 {
			return nil, kernel.BadAuthRequest("素材 ID 无效")
		}
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	assets, err := l.repo.AssetsForUserIDs(userID, unique)
	if err != nil {
		return nil, err
	}
	return clientPayloads(assets), nil
}

func (l *Library) UserAssetsPage(userID string, page int, pageSize int, filter UserAssetPageFilter) (UserAssetPage, error) {
	page, pageSize = normalizeAssetPage(page, pageSize, 40, 120)
	repoFilter := repository.UserAssetPageFilter{
		Kind: filter.Kind, Category: filter.Category, FolderID: filter.FolderID,
		Uncategorized: filter.Uncategorized, Status: filter.Status, Query: filter.Query,
	}
	assets, total, err := l.repo.UserAssetsPage(userID, page, pageSize, repoFilter)
	if err != nil {
		return UserAssetPage{}, err
	}
	kindRows, categoryRows, folderRows, err := l.repo.UserAssetFacets(userID, filter.Status)
	if err != nil {
		return UserAssetPage{}, err
	}
	return UserAssetPage{
		Assets: clientPayloads(assets), KindCounts: assetFacetMap(kindRows), CategoryCounts: assetFacetMap(categoryRows), FolderCounts: assetFacetMap(folderRows),
		Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total,
	}, nil
}

func clientPayloads(assets []model.Asset) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(assets))
	for _, item := range assets {
		if payload := ClientAssetPayload(item); len(payload) > 0 {
			result = append(result, payload)
		}
	}
	return result
}

func summaryFromAsset(item model.Asset) Summary {
	return Summary{
		ID: item.ID, FolderID: item.FolderID, Kind: item.Kind, Category: string(item.Category),
		Status: string(item.Status), Title: item.Title, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
}

func normalizeAssetPage(page, pageSize, fallback, maximum int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = fallback
	}
	if pageSize > maximum {
		pageSize = maximum
	}
	return page, pageSize
}

func assetFacetMap(rows []repository.UserAssetFacetRow) map[string]int64 {
	result := make(map[string]int64, len(rows))
	for _, row := range rows {
		result[row.Key] = row.Count
	}
	return result
}

func isNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
