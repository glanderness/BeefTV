package canvas

import (
	"encoding/json"

	"infinite-canvas/backend/internal/repository"
)

// UserAssetPage 是素材库分页合同，由 canvas 拥有；操作层与 HTTP 入口共用，不经过 app。
type UserAssetPage struct {
	Assets         []json.RawMessage `json:"assets"`
	KindCounts     map[string]int64  `json:"kindCounts"`
	CategoryCounts map[string]int64  `json:"categoryCounts"`
	FolderCounts   map[string]int64  `json:"folderCounts"`
	Page           int               `json:"page"`
	PageSize       int               `json:"pageSize"`
	Total          int64             `json:"total"`
	HasMore        bool              `json:"hasMore"`
}

// UserAssetPageFilter 是素材库分页过滤；字段语义与仓储层一致。
type UserAssetPageFilter struct {
	Kind          string
	Category      string
	FolderID      *string
	Uncategorized bool
	Status        string
	Query         string
}

func (s *Service) UserAssetsPage(userID string, page int, pageSize int, filter UserAssetPageFilter) (UserAssetPage, error) {
	page, pageSize = normalizeAssetPage(page, pageSize, 40, 120)
	repoFilter := repository.UserAssetPageFilter{
		Kind: filter.Kind, Category: filter.Category, FolderID: filter.FolderID,
		Uncategorized: filter.Uncategorized, Status: filter.Status, Query: filter.Query,
	}
	assets, total, err := s.repo.UserAssetsPage(userID, page, pageSize, repoFilter)
	if err != nil {
		return UserAssetPage{}, err
	}
	rawAssets := make([]json.RawMessage, 0, len(assets))
	for _, asset := range assets {
		if payload := ClientAssetPayload(asset); len(payload) > 0 {
			rawAssets = append(rawAssets, payload)
		}
	}
	kindRows, categoryRows, folderRows, err := s.repo.UserAssetFacets(userID, filter.Status)
	if err != nil {
		return UserAssetPage{}, err
	}
	return UserAssetPage{
		Assets: rawAssets, KindCounts: assetFacetMap(kindRows), CategoryCounts: assetFacetMap(categoryRows), FolderCounts: assetFacetMap(folderRows),
		Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total,
	}, nil
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
