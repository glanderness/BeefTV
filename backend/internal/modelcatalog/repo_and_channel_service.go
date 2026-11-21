package modelcatalog

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/provider"
	"infinite-canvas/backend/internal/provider/bailian"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

type repoCatalogLoader struct {
	repo *repository.Repository
}

func NewRepoCatalogLoader(repo *repository.Repository) CatalogLoader {
	return repoCatalogLoader{repo: repo}
}

func (l repoCatalogLoader) Load(ctx context.Context) ([]model.LogicalModel, map[string]LogicalModelGraph, []model.ModelChannel, error) {
	if l.repo == nil {
		return nil, nil, nil, errors.New("repository unavailable")
	}
	repo := l.repo.WithContext(ctx)
	items, err := repo.LogicalModels(false)
	if err != nil {
		return nil, nil, nil, err
	}
	graphs, err := repo.LogicalModelGraphs(items, false)
	if err != nil {
		return nil, nil, nil, err
	}
	systemChannelIDs := make([]string, 0)
	converted := make(map[string]LogicalModelGraph, len(graphs))
	for id, graph := range graphs {
		if graph == nil {
			continue
		}
		converted[id] = CatalogGraphFromRepo(graph)
		for _, channelModel := range graph.ChannelModels {
			systemChannelIDs = append(systemChannelIDs, channelModel.ChannelID)
		}
	}
	systemChannels, err := repo.SystemChannelsByIDs(systemChannelIDs, false)
	if err != nil {
		return nil, nil, nil, err
	}
	return items, converted, systemChannels, nil
}

func CatalogGraphFromRepo(graph *repository.LogicalModelGraph) LogicalModelGraph {
	if graph == nil {
		return LogicalModelGraph{}
	}
	return LogicalModelGraph{Model: graph.Model, Revision: graph.Revision, Routes: graph.Routes, ChannelModels: graph.ChannelModels}
}

type repoRouteStore struct {
	repo *repository.Repository
}

func NewRepoRouteStore(repo *repository.Repository) RouteStore {
	return repoRouteStore{repo: repo}
}

func (s repoRouteStore) NextPrefixedID(prefix string) (string, error) {
	return s.repo.NextPrefixedID(prefix)
}
func (s repoRouteStore) CreateRouteAttempt(item *model.RouteAttempt) error {
	return s.repo.CreateRouteAttempt(item)
}
func (s repoRouteStore) SaveRouteAttempt(item *model.RouteAttempt) error {
	return s.repo.SaveRouteAttempt(item)
}
func (s repoRouteStore) MarkRouteAttemptDispatching(id string) error {
	return s.repo.MarkRouteAttemptDispatching(id)
}
func (s repoRouteStore) RouteAttempts(taskID string, routeRun int) ([]model.RouteAttempt, error) {
	return s.repo.RouteAttempts(taskID, routeRun)
}
func (s repoRouteStore) ChannelModelByID(channelID, id string) (*model.ChannelModel, error) {
	return s.repo.ChannelModelByID(channelID, id)
}
func (s repoRouteStore) ChannelModel(id string) (*model.ChannelModel, error) {
	return s.repo.ChannelModel(id)
}
func (s repoRouteStore) LogicalModel(id string) (*model.LogicalModel, error) {
	return s.repo.LogicalModel(id)
}
func (s repoRouteStore) LogicalModelRevision(id string) (*model.LogicalModelRevision, error) {
	return s.repo.LogicalModelRevision(id)
}
func (s repoRouteStore) LogicalModelRoute(id string) (*model.LogicalModelRoute, error) {
	return s.repo.LogicalModelRoute(id)
}
func (s repoRouteStore) LogicalModelRoutes(revisionID string, includeDisabled bool) ([]model.LogicalModelRoute, error) {
	return s.repo.LogicalModelRoutes(revisionID, includeDisabled)
}
func (s repoRouteStore) ChannelModelsByIDs(ids []string) ([]model.ChannelModel, error) {
	return s.repo.ChannelModelsByIDs(ids)
}
func (s repoRouteStore) SystemChannel(id string) (*model.ModelChannel, error) {
	return s.repo.SystemChannel(id)
}
func (s repoRouteStore) SystemChannelsByIDs(ids []string, includeDisabled bool) ([]model.ModelChannel, error) {
	return s.repo.SystemChannelsByIDs(ids, includeDisabled)
}
func (s repoRouteStore) SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID string) error {
	return s.repo.SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID)
}
func (s repoRouteStore) UpdateTaskProviderState(taskID, providerRequestID, pollStage string, nextPollAt *time.Time) error {
	return s.repo.UpdateTaskProviderState(taskID, providerRequestID, pollStage, nextPollAt)
}

func ImageSubmissionViewFromRepo(repo *repository.Repository, attempt *model.RouteAttempt, task *model.Task) ImageSubmissionView {
	if repo == nil || attempt == nil || task == nil {
		return ImageSubmissionView{}
	}
	row, err := repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err == nil {
		return ImageSubmissionView{Found: true, Accepted: row.ResponseAccepted}
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ImageSubmissionView{}
	}
	return ImageSubmissionView{Err: err}
}

var pluginsInitOnce sync.Once

func InitModelCatalogPlugins() {
	pluginsInitOnce.Do(func() {
		provider.Register(bailian.New())
	})
}

func ExtraChannelModelCatalogItems(baseURL, apiFormat string, headers []ChannelHeader) []ChannelModelCatalogItem {
	InitModelCatalogPlugins()
	discovery := provider.MatchProvider(baseURL, OutboundHeadersMap(headers))
	if discovery == nil {
		return nil
	}
	extra := discovery.AdditionalModels(provider.DiscoveryConfig{
		BaseURL:   baseURL,
		APIFormat: apiFormat,
		Headers:   OutboundHeadersMap(headers),
		Region:    ModelCatalogRegion(baseURL),
	})
	if len(extra) == 0 {
		return nil
	}
	items := make([]ChannelModelCatalogItem, 0, len(extra))
	for _, modelItem := range extra {
		item := ProviderCatalogItem(modelItem)
		if item.ID == "" {
			continue
		}
		items = append(items, item)
	}
	return items
}

func ProviderCatalogItem(item provider.Model) ChannelModelCatalogItem {
	modelType := ""
	for _, capability := range item.Capability {
		if normalized := NormalizeCatalogModelType(capability); normalized != "" {
			modelType = normalized
			break
		}
	}
	return ChannelModelCatalogItem{
		ID:                     strings.TrimPrefix(strings.TrimSpace(item.ID), "models/"),
		DisplayName:            strings.TrimSpace(item.DisplayName),
		ModelType:              modelType,
		SupportedEndpointTypes: NormalizeCatalogEndpointTypes(item.SupportedEndpointTypes),
	}
}

func OutboundHeadersMap(headers []ChannelHeader) map[string]string {
	result := make(map[string]string, len(headers))
	for _, header := range headers {
		result[header.Name] = header.Value
	}
	return result
}

func ModelCatalogRegion(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, "dashscope-us") {
		return "us-east-1"
	}
	if strings.Contains(host, "ap-southeast-1") {
		return "ap-southeast-1"
	}
	return "cn-beijing"
}

func IsPluginEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("ENABLE_PROVIDER_PLUGINS")))
	return value == "true" || value == "1"
}

func BuildModelCatalogResponse(frontendEnabled bool, publicLogical func(*ModelRequestIntent) ([]PublicLogicalModel, error), publicSystem func(*ModelRequestIntent) ([]PublicChannelCatalog, error), intent *ModelRequestIntent) (*CatalogResponse, error) {
	if frontendEnabled {
		models, err := publicLogical(intent)
		if err != nil {
			return nil, err
		}
		response := NewCatalogResponse(CatalogSourceFrontend, models, nil)
		return &response, nil
	}
	channels, err := publicSystem(intent)
	if err != nil {
		return nil, err
	}
	response := NewCatalogResponse(CatalogSourceSystem, nil, channels)
	return &response, nil
}

func PublicSystemChannelCatalogFromRepo(repo *repository.Repository, intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	channels, err := repo.SystemChannels(true)
	if err != nil {
		return nil, err
	}
	return PublicSystemChannelCatalog(channels, func(channelID string) ([]model.ChannelModel, error) {
		return repo.ChannelModels(channelID, false)
	}, intent)
}
