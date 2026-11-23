package repository

import (
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) Workspace(id string) (*model.Workspace, error) {
	if cached := r.cachedDefaultWorkspace(); cached != nil && cached.ID == id {
		return cached, nil
	}
	var value model.Workspace
	if err := r.db.First(&value, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &value, nil
}

func (r *Repository) DefaultWorkspace() (*model.Workspace, error) {
	if cached := r.cachedDefaultWorkspace(); cached != nil {
		return cached, nil
	}
	var value model.Workspace
	if err := r.db.Order("created_at ASC").First(&value).Error; err != nil {
		return nil, err
	}
	r.storeDefaultWorkspace(&value)
	return &value, nil
}

func (r *Repository) cachedDefaultWorkspace() *model.Workspace {
	if r == nil || r.workspaceCache == nil || r.HoldsTransaction() {
		return nil
	}
	r.workspaceCache.mu.RLock()
	cached := r.workspaceCache.defaultValue
	r.workspaceCache.mu.RUnlock()
	if cached == nil {
		return nil
	}
	copyValue := *cached
	return &copyValue
}

func (r *Repository) storeDefaultWorkspace(value *model.Workspace) {
	if r == nil || r.workspaceCache == nil || value == nil || value.ID == "" || r.HoldsTransaction() {
		return
	}
	copyValue := *value
	r.workspaceCache.mu.Lock()
	if r.workspaceCache.defaultValue == nil {
		r.workspaceCache.defaultValue = &copyValue
	}
	r.workspaceCache.mu.Unlock()
}
