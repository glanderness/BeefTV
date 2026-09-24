package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

type AssetsSyncRequest struct {
	Assets []json.RawMessage `json:"assets"`
}

type UserDataSummary struct {
	ID        string           `json:"id"`
	FolderID  string           `json:"folderId,omitempty"`
	Kind      string           `json:"kind,omitempty"`
	Category  string           `json:"category,omitempty"`
	Status    string           `json:"status,omitempty"`
	Title     string           `json:"title"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
	Revision  int64            `json:"revision,omitempty"`
	SaveAudit *CanvasSaveAudit `json:"-"`
}

type CanvasSaveAudit struct {
	NodesBefore int
	NodesAfter  int
}

func canvasNodeCount(payload string) int {
	var document struct {
		Nodes []json.RawMessage `json:"nodes"`
	}
	_ = json.Unmarshal([]byte(payload), &document)
	return len(document.Nodes)
}

type UserDataSnapshot struct {
	Assets   []json.RawMessage `json:"assets"`
	Projects []json.RawMessage `json:"projects"`
}

func (s *Service) UserDataSnapshot(userID string) (UserDataSnapshot, error) {
	assets, err := s.UserAssets(userID)
	if err != nil {
		return UserDataSnapshot{}, err
	}
	projects, err := s.UserCanvasProjects(userID)
	if err != nil {
		return UserDataSnapshot{}, err
	}
	return UserDataSnapshot{Assets: assets, Projects: projects}, nil
}

func (s *Service) UserAssetSummaries(userID string) ([]UserDataSummary, error) {
	assets, err := s.repo.AssetSummaries(userID)
	if err != nil {
		return nil, err
	}
	result := make([]UserDataSummary, 0, len(assets))
	for _, asset := range assets {
		result = append(result, UserDataSummary{ID: asset.ID, FolderID: asset.FolderID, Kind: asset.Kind, Category: string(asset.Category), Status: string(asset.Status), Title: asset.Title, CreatedAt: asset.CreatedAt, UpdatedAt: asset.UpdatedAt})
	}
	return result, nil
}

func (s *Service) UserAsset(userID string, id string) (json.RawMessage, error) {
	asset, err := s.repo.AssetForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return ClientAssetPayload(*asset), nil
}

func (s *Service) UpsertUserAsset(userID string, raw json.RawMessage) (UserDataSummary, error) {
	asset, err := AssetFromJSON(userID, raw)
	if err != nil {
		return UserDataSummary{}, err
	}
	err = s.host.WithStorageLock(func() error {
		if asset.FolderID != "" {
			if _, err := s.repo.AssetFolderForUser(userID, asset.FolderID); err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return kernel.BadAuthRequest("素材分类不存在")
				}
				return err
			}
		}
		existing, existingErr := s.repo.AssetForUser(userID, asset.ID)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		if existing != nil && existing.PayloadJSON != asset.PayloadJSON {
			if err := s.ValidateAssetCanvasReferences(userID, asset); err != nil {
				return err
			}
		}
		existingBytes := int64(0)
		if existing != nil {
			existingBytes = int64(len([]byte(existing.PayloadJSON)))
		}
		if err := s.host.StructuredQuota(userID, "asset", errors.Is(existingErr, gorm.ErrRecordNotFound), int64(len(raw))-existingBytes); err != nil {
			return err
		}
		if err := s.repo.UpsertAsset(&asset); err != nil {
			return err
		}
		if existingErr != nil {
			s.host.RecordActivity(userID, "asset", 1)
		}
		return nil
	})
	if err != nil {
		return UserDataSummary{}, err
	}
	return UserDataSummary{ID: asset.ID, FolderID: asset.FolderID, Kind: asset.Kind, Category: string(asset.Category), Status: string(asset.Status), Title: asset.Title, CreatedAt: asset.CreatedAt, UpdatedAt: asset.UpdatedAt}, nil
}

func (s *Service) DeleteUserAsset(userID string, id string) error {
	return s.host.WithStorageLock(func() error {
		return s.host.DeleteUserAssetWithResources(userID, id)
	})
}

func (s *Service) UserAssets(userID string) ([]json.RawMessage, error) {
	assets, err := s.repo.Assets(userID)
	if err != nil {
		return nil, err
	}
	result := make([]json.RawMessage, 0, len(assets))
	for _, asset := range assets {
		if payload := ClientAssetPayload(asset); len(payload) > 0 {
			result = append(result, payload)
		}
	}
	return result, nil
}

func (s *Service) ReplaceUserAssets(userID string, req AssetsSyncRequest) ([]json.RawMessage, error) {
	assets := make([]model.Asset, 0, len(req.Assets))
	var totalBytes int64
	for _, raw := range req.Assets {
		item, err := AssetFromJSON(userID, raw)
		if err != nil {
			return nil, err
		}
		assets = append(assets, item)
		totalBytes += int64(len(raw))
	}
	err := s.host.WithStorageLock(func() error {
		if err := s.ValidateAssetReplacementCanvasReferences(userID, assets); err != nil {
			return err
		}
		if err := s.host.StructuredReplacementQuota(userID, "asset", len(assets), totalBytes); err != nil {
			return err
		}
		if err := s.repo.ReplaceAssets(userID, assets); err != nil {
			return err
		}
		if len(assets) > 0 {
			s.host.RecordActivity(userID, "asset", len(assets))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.UserAssets(userID)
}

func (s *Service) UserCanvasProjects(userID string) ([]json.RawMessage, error) {
	projects, err := s.repo.CanvasProjects(userID)
	if err != nil {
		return nil, err
	}
	result := make([]json.RawMessage, 0, len(projects))
	for _, project := range projects {
		if strings.TrimSpace(project.PayloadJSON) != "" {
			payload, err := canvasProjectPayload(project)
			if err != nil {
				return nil, err
			}
			result = append(result, payload)
		}
	}
	return result, nil
}

func (s *Service) UserCanvasProjectSummaries(userID string) ([]UserDataSummary, error) {
	projects, err := s.repo.CanvasProjectSummaries(userID)
	if err != nil {
		return nil, err
	}
	result := make([]UserDataSummary, 0, len(projects))
	for _, project := range projects {
		result = append(result, UserDataSummary{ID: project.ID, Title: project.Title, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt, Revision: project.Revision})
	}
	return result, nil
}

func (s *Service) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	project, err := s.repo.CanvasProjectForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return canvasProjectPayload(*project)
}

func (s *Service) UpsertUserCanvasProject(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.upsertUserCanvasProjectWithHistory(userID, raw, "automatic")
}

func (s *Service) CommitUserCanvasProjectAssets(userID string, raw json.RawMessage, assetPayloads []json.RawMessage) (UserDataSummary, error) {
	items, err := canvasAssetsFromJSON(userID, assetPayloads)
	if err != nil {
		return UserDataSummary{}, err
	}
	bound, err := BindCanvasMediaAssets(raw, items)
	if err != nil {
		return UserDataSummary{}, err
	}
	return s.upsertUserCanvasProjectWithAssets(userID, bound, items, "automatic")
}

func canvasAssetsFromJSON(userID string, assetPayloads []json.RawMessage) ([]model.Asset, error) {
	items := make([]model.Asset, 0, len(assetPayloads))
	for _, payload := range assetPayloads {
		asset, err := AssetFromJSON(userID, payload)
		if err != nil {
			return nil, err
		}
		items = append(items, asset)
	}
	return items, nil
}

// CommitUserCanvasGenerationAssets applies only entities stamped by effectKey
// to the latest canvas. Generation can finish minutes after it started, so its
// original whole-document revision must not overwrite intervening user edits.
func (s *Service) CommitUserCanvasGenerationAssets(userID string, raw json.RawMessage, assetPayloads []json.RawMessage, effectKey string) (UserDataSummary, error) {
	effectKey = strings.TrimSpace(effectKey)
	if effectKey == "" {
		return UserDataSummary{}, kernel.BadAuthRequest("生成结果缺少幂等标识")
	}
	var identity struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &identity); err != nil || strings.TrimSpace(identity.ID) == "" {
		return UserDataSummary{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	current, err := s.UserCanvasProject(userID, identity.ID)
	if err != nil {
		return UserDataSummary{}, err
	}
	merged, err := mergeCanvasGenerationEffect(current, raw, effectKey)
	if err != nil {
		return UserDataSummary{}, err
	}
	items, err := canvasAssetsFromJSON(userID, assetPayloads)
	if err != nil {
		return UserDataSummary{}, err
	}
	bound, err := BindCanvasMediaAssets(merged, items)
	if err != nil {
		return UserDataSummary{}, err
	}
	return s.upsertUserCanvasProjectWithAssets(userID, bound, items, "automatic")
}

func mergeCanvasGenerationEffect(currentRaw, generatedRaw json.RawMessage, effectKey string) (json.RawMessage, error) {
	var current, generated map[string]json.RawMessage
	if json.Unmarshal(currentRaw, &current) != nil || json.Unmarshal(generatedRaw, &generated) != nil {
		return nil, kernel.BadAuthRequest("画布数据格式错误")
	}
	affectedNodeIDs := map[string]bool{}
	mergedAny := false
	mergeStamped := func(field string, nestedMetadata bool) error {
		var latest, incoming []map[string]json.RawMessage
		if value := current[field]; len(value) > 0 && json.Unmarshal(value, &latest) != nil {
			return kernel.BadAuthRequest("画布" + field + "数据格式错误")
		}
		if value := generated[field]; len(value) > 0 && json.Unmarshal(value, &incoming) != nil {
			return kernel.BadAuthRequest("画布" + field + "数据格式错误")
		}
		positions := map[string]int{}
		for index, item := range latest {
			var id string
			_ = json.Unmarshal(item["id"], &id)
			positions[id] = index
		}
		for _, item := range incoming {
			target := item
			if nestedMetadata {
				var metadata map[string]json.RawMessage
				if json.Unmarshal(item["metadata"], &metadata) != nil {
					continue
				}
				target = metadata
			}
			var keys []string
			_ = json.Unmarshal(target["generationEffectKeys"], &keys)
			if !slices.Contains(keys, effectKey) {
				continue
			}
			var id string
			_ = json.Unmarshal(item["id"], &id)
			if id == "" {
				continue
			}
			if index, exists := positions[id]; exists {
				latest[index] = item
			} else {
				positions[id] = len(latest)
				latest = append(latest, item)
			}
			if field == "nodes" {
				affectedNodeIDs[id] = true
			}
			mergedAny = true
		}
		encoded, err := json.Marshal(latest)
		if err == nil {
			current[field] = encoded
		}
		return err
	}
	if err := mergeStamped("nodes", true); err != nil {
		return nil, err
	}
	if err := mergeStamped("chatSessions", false); err != nil {
		return nil, err
	}
	if !mergedAny {
		return nil, kernel.BadAuthRequest("生成结果与幂等标识不匹配")
	}
	if len(affectedNodeIDs) > 0 {
		var latest, incoming []map[string]json.RawMessage
		_ = json.Unmarshal(current["connections"], &latest)
		_ = json.Unmarshal(generated["connections"], &incoming)
		positions := map[string]int{}
		for index, item := range latest {
			var id string
			_ = json.Unmarshal(item["id"], &id)
			positions[id] = index
		}
		for _, item := range incoming {
			var id, from, to string
			_ = json.Unmarshal(item["id"], &id)
			_ = json.Unmarshal(item["fromNodeId"], &from)
			_ = json.Unmarshal(item["toNodeId"], &to)
			if id == "" || (!affectedNodeIDs[from] && !affectedNodeIDs[to]) {
				continue
			}
			if index, exists := positions[id]; exists {
				latest[index] = item
			} else {
				positions[id] = len(latest)
				latest = append(latest, item)
			}
		}
		current["connections"], _ = json.Marshal(latest)
	}
	return json.Marshal(current)
}

// DeleteUserCanvasNode applies a single-node mutation without exposing the
// whole canvas document to the caller. It still uses the existing revision and
// history machinery, so old clients and conflict semantics remain unchanged.
func (s *Service) DeleteUserCanvasNode(userID, canvasID, nodeID string) (UserDataSummary, error) {
	project, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, err
	}
	raw, err := canvasProjectPayload(*project)
	if err != nil {
		return UserDataSummary{}, err
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return UserDataSummary{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(document["nodes"], &nodes); err != nil {
		return UserDataSummary{}, kernel.BadAuthRequest("画布节点数据格式错误")
	}
	kept := nodes[:0]
	removed := false
	for _, node := range nodes {
		var id string
		_ = json.Unmarshal(node["id"], &id)
		if id == nodeID {
			removed = true
			continue
		}
		kept = append(kept, node)
	}
	if !removed {
		return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "节点不存在")
	}
	document["nodes"], err = json.Marshal(kept)
	if err != nil {
		return UserDataSummary{}, err
	}
	updated, err := json.Marshal(document)
	if err != nil {
		return UserDataSummary{}, err
	}
	return s.upsertUserCanvasProjectWithHistory(userID, updated, "automatic")
}

func (s *Service) UpdateUserCanvasNode(userID, canvasID, nodeID string, patch map[string]json.RawMessage) (UserDataSummary, error) {
	project, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, err
	}
	raw, err := canvasProjectPayload(*project)
	if err != nil {
		return UserDataSummary{}, err
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return UserDataSummary{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(document["nodes"], &nodes); err != nil {
		return UserDataSummary{}, kernel.BadAuthRequest("画布节点数据格式错误")
	}
	found := false
	for _, node := range nodes {
		var id string
		_ = json.Unmarshal(node["id"], &id)
		if id != nodeID {
			continue
		}
		found = true
		for key, value := range patch {
			if key == "id" || key == "type" {
				continue
			}
			node[key] = value
		}
		break
	}
	if !found {
		return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "节点不存在")
	}
	document["nodes"], err = json.Marshal(nodes)
	if err != nil {
		return UserDataSummary{}, err
	}
	updated, err := json.Marshal(document)
	if err != nil {
		return UserDataSummary{}, err
	}
	return s.upsertUserCanvasProjectWithHistory(userID, updated, "automatic")
}

func (s *Service) ConnectUserCanvasNodes(userID, canvasID, fromNodeID, toNodeID string, connection map[string]json.RawMessage) (UserDataSummary, error) {
	project, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return UserDataSummary{}, err
	}
	raw, err := canvasProjectPayload(*project)
	if err != nil {
		return UserDataSummary{}, err
	}
	var document map[string]json.RawMessage
	if err = json.Unmarshal(raw, &document); err != nil {
		return UserDataSummary{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	var nodes []map[string]json.RawMessage
	_ = json.Unmarshal(document["nodes"], &nodes)
	nodeIDs := map[string]bool{}
	for _, node := range nodes {
		var id string
		_ = json.Unmarshal(node["id"], &id)
		nodeIDs[id] = true
	}
	if !nodeIDs[fromNodeID] || !nodeIDs[toNodeID] {
		return UserDataSummary{}, kernel.NewAppError(http.StatusNotFound, "连接节点不存在")
	}
	var connections []map[string]json.RawMessage
	_ = json.Unmarshal(document["connections"], &connections)
	for _, item := range connections {
		var from, to string
		_ = json.Unmarshal(item["fromNodeId"], &from)
		_ = json.Unmarshal(item["toNodeId"], &to)
		if from == fromNodeID && to == toNodeID {
			return UserDataSummary{}, kernel.NewAppError(http.StatusConflict, "节点连接已存在")
		}
	}
	if connection == nil {
		connection = map[string]json.RawMessage{}
	}
	connection["id"], _ = json.Marshal(kernel.NewID())
	connection["fromNodeId"], _ = json.Marshal(fromNodeID)
	connection["toNodeId"], _ = json.Marshal(toNodeID)
	connections = append(connections, connection)
	document["connections"], err = json.Marshal(connections)
	if err != nil {
		return UserDataSummary{}, err
	}
	updated, err := json.Marshal(document)
	if err != nil {
		return UserDataSummary{}, err
	}
	return s.upsertUserCanvasProjectWithHistory(userID, updated, "automatic")
}

func (s *Service) upsertUserCanvasProjectWithHistory(userID string, raw json.RawMessage, reason string) (UserDataSummary, error) {
	return s.upsertUserCanvasProjectWithAssets(userID, raw, nil, reason)
}

func (s *Service) upsertUserCanvasProjectWithAssets(userID string, raw json.RawMessage, candidateAssets []model.Asset, reason string) (UserDataSummary, error) {
	var version struct {
		Revision *int64 `json:"revision"`
	}
	if err := json.Unmarshal(raw, &version); err != nil {
		return UserDataSummary{}, kernel.BadAuthRequest("画布版本格式错误")
	}
	if version.Revision == nil {
		return UserDataSummary{}, kernel.NewAppError(http.StatusPreconditionRequired, "缺少画布版本，请保留本地草稿后重新加载画布")
	}
	if *version.Revision < 0 || *version.Revision >= 9007199254740991 {
		return UserDataSummary{}, kernel.BadAuthRequest("画布版本无效")
	}
	project, err := canvasProjectFromJSON(userID, raw)
	if err != nil {
		return UserDataSummary{}, err
	}
	var audit CanvasSaveAudit
	createdAssets := 0
	err = s.host.WithStorageLock(func() error {
		if err := s.validateCanvasMediaAssetsWithCandidates(userID, raw, candidateAssets); err != nil {
			return err
		}
		for index := range candidateAssets {
			asset := &candidateAssets[index]
			if asset.FolderID != "" {
				if _, err := s.repo.AssetFolderForUser(userID, asset.FolderID); err != nil {
					return err
				}
			}
			existingAsset, assetErr := s.repo.AssetForUser(userID, asset.ID)
			if assetErr != nil && !errors.Is(assetErr, gorm.ErrRecordNotFound) {
				return assetErr
			}
			if existingAsset != nil && existingAsset.PayloadJSON != asset.PayloadJSON {
				if err := s.ValidateAssetCanvasReferences(userID, *asset); err != nil {
					return err
				}
			}
			existingAssetBytes := int64(0)
			if existingAsset != nil {
				existingAssetBytes = int64(len([]byte(existingAsset.PayloadJSON)))
			}
			creatingAsset := errors.Is(assetErr, gorm.ErrRecordNotFound)
			if err := s.host.StructuredQuota(userID, "asset", creatingAsset, int64(len([]byte(asset.PayloadJSON)))-existingAssetBytes); err != nil {
				return err
			}
			if creatingAsset {
				createdAssets++
			}
		}
		existing, existingErr := s.repo.CanvasProjectForUser(userID, project.ID)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		existingBytes := int64(0)
		project.Revision = *version.Revision
		project.UpdatedAt = time.Now().UTC()
		if existing != nil {
			existingBytes = int64(len([]byte(existing.PayloadJSON)))
			project.CreatedAt = existing.CreatedAt
		}
		if (existing == nil && project.Revision != 0) || (existing != nil && project.Revision != existing.Revision) {
			return canvasRevisionConflict()
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(raw, &payload); err != nil {
			return err
		}
		delete(payload, "revision")
		delete(payload, "remoteContentHash")
		payload["viewport"] = json.RawMessage(`{"x":0,"y":0,"k":1}`)
		if existing != nil {
			var previous map[string]json.RawMessage
			if json.Unmarshal([]byte(existing.PayloadJSON), &previous) == nil && previous["viewport"] != nil {
				payload["viewport"] = previous["viewport"]
			}
		}
		payload["createdAt"], _ = json.Marshal(project.CreatedAt)
		payload["updatedAt"], _ = json.Marshal(project.UpdatedAt)
		cleaned, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		project.PayloadJSON = string(cleaned)
		if err := s.host.StructuredQuota(userID, "canvas", errors.Is(existingErr, gorm.ErrRecordNotFound), int64(len(cleaned))-existingBytes); err != nil {
			return err
		}
		if err := SaveDocumentWithHistoryAndAssets(s.repo, existing, &project, candidateAssets, reason); err != nil {
			if errors.Is(err, repository.ErrCanvasRevisionConflict) {
				return canvasRevisionConflict()
			}
			if errors.Is(err, repository.ErrCanvasHistoryResourceMissing) {
				return kernel.NewAppError(http.StatusConflict, "画布引用的素材已变化，当前内容未被覆盖，请保留草稿并重新加载")
			}
			return err
		}
		audit.NodesAfter = canvasNodeCount(project.PayloadJSON)
		if existing != nil {
			audit.NodesBefore = canvasNodeCount(existing.PayloadJSON)
		}
		if existingErr != nil || existing.PayloadJSON != project.PayloadJSON || existing.Title != project.Title {
			s.host.RecordActivity(userID, "canvas", 1)
		}
		return nil
	})
	if err != nil {
		return UserDataSummary{}, err
	}
	if createdAssets > 0 {
		s.host.RecordActivity(userID, "asset", createdAssets)
	}
	return UserDataSummary{ID: project.ID, Title: project.Title, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt, Revision: project.Revision, SaveAudit: &audit}, nil
}

func (s *Service) DeleteUserCanvasProject(userID string, id string) error {
	return s.repo.DeleteCanvasProject(userID, id)
}

func AssetFromJSON(userID string, raw json.RawMessage) (model.Asset, error) {
	if err := ValidateSyncedPayload(raw, "素材"); err != nil {
		return model.Asset{}, err
	}
	var payload struct {
		ID               string `json:"id"`
		FolderID         string `json:"folderId"`
		Kind             string `json:"kind"`
		Category         string `json:"category"`
		Status           string `json:"status"`
		PrimaryVersionID string `json:"primaryVersionId"`
		Title            string `json:"title"`
		CreatedAt        string `json:"createdAt"`
		UpdatedAt        string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.Asset{}, kernel.BadAuthRequest("素材数据格式错误")
	}
	now := time.Now()
	createdAt := parseClientTime(payload.CreatedAt, now)
	updatedAt := parseClientTime(payload.UpdatedAt, createdAt)
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		id = kernel.NewID()
	}
	if utf8.RuneCountInString(id) > model.AssetIDMaxLength {
		return model.Asset{}, kernel.BadAuthRequest("素材 ID 不能超过 80 个字符")
	}
	primaryVersionID := strings.TrimSpace(payload.PrimaryVersionID)
	if utf8.RuneCountInString(primaryVersionID) > 36 {
		return model.Asset{}, kernel.BadAuthRequest("素材主版本 ID 不能超过 36 个字符")
	}
	if err := validateUserAssetDocument(raw); err != nil {
		return model.Asset{}, err
	}
	category := model.NormalizeAssetCategory(model.AssetCategory(payload.Category), payload.Kind)
	status := model.AssetVersionStatus(strings.TrimSpace(payload.Status))
	if status == "" {
		status = model.AssetVersionStatusConfirmed
	}
	return model.Asset{
		ID:               id,
		UserID:           userID,
		FolderID:         strings.TrimSpace(payload.FolderID),
		Kind:             strings.TrimSpace(payload.Kind),
		Category:         category,
		Status:           status,
		PrimaryVersionID: primaryVersionID,
		Title:            strings.TrimSpace(payload.Title),
		PayloadJSON:      string(raw),
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
	}, nil
}

func canvasProjectFromJSON(userID string, raw json.RawMessage) (model.CanvasProject, error) {
	if err := ValidateSyncedPayload(raw, "画布"); err != nil {
		return model.CanvasProject{}, err
	}
	var payload struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		ProjectID string `json:"projectId"`
		CreatedAt string `json:"createdAt"`
		UpdatedAt string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.CanvasProject{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	now := time.Now()
	createdAt := parseClientTime(payload.CreatedAt, now)
	updatedAt := parseClientTime(payload.UpdatedAt, createdAt)
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		id = kernel.NewID()
	}
	return model.CanvasProject{
		ID:          id,
		UserID:      userID,
		ProjectID:   strings.TrimSpace(payload.ProjectID),
		Title:       strings.TrimSpace(payload.Title),
		PayloadJSON: string(raw),
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
	}, nil
}

func ValidateSyncedPayload(raw json.RawMessage, label string) error {
	if len(raw) > 4<<20 {
		return kernel.BadAuthRequest(label + "数据超过 4MB，请先把媒体文件保存到资源存储")
	}
	var payload interface{}
	if err := json.Unmarshal(raw, &payload); err == nil && ContainsInlineMediaDataURL(payload) {
		return kernel.BadAuthRequest(label + "数据包含内嵌媒体，请先上传到资源存储")
	}
	return nil
}

// 同步数据只禁止作为字段值存在的媒体 Data URL；提示词和上游错误文案可能合法提到相同字符串。
func ContainsInlineMediaDataURL(value interface{}) bool {
	switch item := value.(type) {
	case string:
		text := strings.ToLower(strings.TrimSpace(item))
		return strings.HasPrefix(text, "data:image/") || strings.HasPrefix(text, "data:video/") || strings.HasPrefix(text, "data:audio/")
	case []interface{}:
		for _, child := range item {
			if ContainsInlineMediaDataURL(child) {
				return true
			}
		}
	case map[string]interface{}:
		for _, child := range item {
			if ContainsInlineMediaDataURL(child) {
				return true
			}
		}
	}
	return false
}

func parseClientTime(value string, fallback time.Time) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	return fallback
}
