package main

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/depthcapture"
)

// Three metadata sources can each consume six seconds before failing over.
const depthComponentCallTimeout = 25 * time.Second

func (a *DesktopApp) depthComponents() (*depthcapture.Service, func(), error) {
	a.mu.RLock()
	busy := a.migrating || a.closing
	a.mu.RUnlock()
	if busy {
		return nil, nil, errors.New("工作区正在关闭或迁移，请稍后重试")
	}
	runtime, _, release, err := a.referenceWorkspace()
	if err != nil {
		return nil, nil, err
	}
	components := runtime.DepthComponents()
	if components == nil {
		release()
		return nil, nil, errors.New("请先登录工作区")
	}
	return components, release, nil
}

func (a *DesktopApp) DepthComponentStatus(refresh bool) (depthcapture.ComponentState, error) {
	components, release, err := a.depthComponents()
	if err != nil {
		return depthcapture.ComponentState{}, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), depthComponentCallTimeout)
	defer cancel()
	return components.ComponentStatus(ctx, refresh)
}

func (a *DesktopApp) DownloadDepthComponents() (depthcapture.ComponentState, error) {
	components, release, err := a.depthComponents()
	if err != nil {
		return depthcapture.ComponentState{}, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), depthComponentCallTimeout)
	defer cancel()
	return components.StartComponentDownload(ctx)
}

func (a *DesktopApp) PauseDepthComponentDownload() (depthcapture.ComponentState, error) {
	components, release, err := a.depthComponents()
	if err != nil {
		return depthcapture.ComponentState{}, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), depthComponentCallTimeout)
	defer cancel()
	if err := components.PauseComponentDownload(ctx); err != nil {
		return depthcapture.ComponentState{}, err
	}
	return components.ComponentStatus(ctx)
}
