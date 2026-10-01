package plugins

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Store persists user and platform plugin activation. Runtime registry state
// is not stored here; Runtime owns plugin_registry.json and package files.
type Store interface {
	PluginPlatformState(pluginID string) (*model.PluginPlatformState, error)
	UserPluginState(userID, pluginID string) (*model.UserPluginState, error)
	SaveUserPluginState(state *model.UserPluginState) error
	SavePluginPlatformState(state *model.PluginPlatformState) error
	EnabledPluginUserCounts() (map[string]int64, error)
	DeleteUserPluginStates(pluginID string) error
	DeletePluginPlatformState(pluginID string) error
}

type repositoryStore struct {
	repo *repository.Repository
}

func NewRepositoryStore(repo *repository.Repository) Store {
	if repo == nil {
		return nil
	}
	return repositoryStore{repo: repo}
}

func (s repositoryStore) PluginPlatformState(pluginID string) (*model.PluginPlatformState, error) {
	return s.repo.PluginPlatformState(pluginID)
}

func (s repositoryStore) UserPluginState(userID, pluginID string) (*model.UserPluginState, error) {
	return s.repo.UserPluginState(userID, pluginID)
}

func (s repositoryStore) SaveUserPluginState(state *model.UserPluginState) error {
	return s.repo.SaveUserPluginState(state)
}

func (s repositoryStore) SavePluginPlatformState(state *model.PluginPlatformState) error {
	return s.repo.SavePluginPlatformState(state)
}

func (s repositoryStore) EnabledPluginUserCounts() (map[string]int64, error) {
	return s.repo.EnabledPluginUserCounts()
}

func (s repositoryStore) DeleteUserPluginStates(pluginID string) error {
	return s.repo.DeleteUserPluginStates(pluginID)
}

func (s repositoryStore) DeletePluginPlatformState(pluginID string) error {
	return s.repo.DeletePluginPlatformState(pluginID)
}
