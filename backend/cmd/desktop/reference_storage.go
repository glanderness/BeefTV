package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"infinite-canvas/backend/internal/referencestorage"
)

func (a *DesktopApp) ReferenceStorageSettings() (referencestorage.PublicConfig, error) {
	a.mu.RLock()
	dir := a.dataDir
	a.mu.RUnlock()
	config, err := referencestorage.Load(dir)
	return config.Public(), err
}

func (a *DesktopApp) SaveReferenceStorage(config referencestorage.Config) (referencestorage.PublicConfig, error) {
	if !a.migrationMu.TryLock() {
		return referencestorage.PublicConfig{}, errors.New("工作区正在迁移，请稍后保存")
	}
	defer a.migrationMu.Unlock()
	a.mu.RLock()
	dir := a.dataDir
	a.mu.RUnlock()
	return referencestorage.Save(dir, config)
}

func (a *DesktopApp) UploadReferenceMedia(ids []string) (map[string]string, error) {
	if len(ids) == 0 || len(ids) > 20 {
		return nil, errors.New("参考素材数量无效")
	}
	if !a.migrationMu.TryLock() {
		return nil, errors.New("工作区正在迁移或上传，请稍后重试")
	}
	defer a.migrationMu.Unlock()
	a.mu.RLock()
	dir := a.dataDir
	runtime := a.runtime()
	closing := a.closing
	a.mu.RUnlock()
	if runtime == nil || closing {
		return nil, errors.New("工作区尚未就绪")
	}
	config, err := referencestorage.Load(dir)
	if err != nil {
		return nil, err
	}
	temp := filepath.Join(dir, "cache", "tmp")
	if err = os.MkdirAll(temp, 0700); err != nil {
		return nil, err
	}
	staging, err := os.MkdirTemp(temp, "reference-upload-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	a.mu.Lock()
	a.migrationCancel = cancel
	if a.closing {
		cancel()
	}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.migrationCancel = nil; a.mu.Unlock() }()
	links := map[string]string{}
	for index, id := range ids {
		if _, exists := links[id]; exists {
			continue
		}
		// CopyOwnedResourceTo checks ownership; arbitrary paths never reach the uploader.
		path := filepath.Join(staging, strconv.Itoa(index))
		if err = runtime.CopyOwnedResourceTo(id, path); err != nil {
			return nil, err
		}
		link, err := referencestorage.Upload(ctx, config, path)
		if err != nil {
			return nil, err
		}
		links[id] = link
	}
	return links, nil
}
