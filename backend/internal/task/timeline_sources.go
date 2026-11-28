package task

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/timelinesources"
)

type repositoryTimelineSources struct {
	repo   *repository.Repository
	canvas timelinesources.CanvasDocumentLoader
}

// NewRepositoryTimelineSources adapts a workspace repository and canvas loader
// to the neutral TimelineSources port used during timeline render admission.
func NewRepositoryTimelineSources(repo *repository.Repository, canvas timelinesources.CanvasDocumentLoader) TimelineSources {
	return repositoryTimelineSources{repo: repo, canvas: canvas}
}

func (r repositoryTimelineSources) UserCanvasProject(userID, canvasID string) (json.RawMessage, error) {
	if r.canvas == nil {
		return nil, gorm.ErrRecordNotFound
	}
	return r.canvas.UserCanvasProject(userID, canvasID)
}

func (r repositoryTimelineSources) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	resourceID = strings.TrimSpace(resourceID)
	if r.repo == nil || resourceID == "" {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: MaterializeErrorResourceMissing, Message: "时间线素材不存在"}
	}
	resource, err := r.repo.ResourceForUser(userID, resourceID)
	if err == nil {
		if resource.Status != model.ResourceStatusReady {
			return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: MaterializeErrorResourceNotReady, Message: "时间线素材尚未就绪"}
		}
		return resource, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if _, lookupErr := r.repo.Resource(resourceID); lookupErr == nil {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPermissionDenied, Reason: MaterializeErrorResourceForeign, Message: "时间线素材不属于当前用户"}
	}
	return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: MaterializeErrorResourceMissing, Message: "时间线素材不存在"}
}

func (r repositoryTimelineSources) OwnedAsset(userID, assetID string) (*model.Asset, error) {
	assetID = strings.TrimSpace(assetID)
	if r.repo == nil || assetID == "" {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: "output_not_ready", Message: "时间线素材尚未就绪"}
	}
	asset, err := r.repo.AssetForUser(userID, assetID)
	if err == nil {
		return asset, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	existing, lookupErr := r.repo.Asset(assetID)
	if lookupErr == nil && existing != nil && existing.UserID != userID {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPermissionDenied, Reason: MaterializeErrorAssetForeign, Message: "时间线素材不属于当前用户"}
	}
	return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: "output_not_ready", Message: "时间线素材尚未就绪"}
}

type ownedMediaReadyLookup struct{ media OwnedMedia }

func (l ownedMediaReadyLookup) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	if l.media == nil {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: MaterializeErrorResourceMissing, Message: "时间线素材不存在"}
	}
	resource, err := l.media.Resource(userID, resourceID)
	if err != nil {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: MaterializeErrorResourceMissing, Message: "时间线素材不存在或不属于当前用户"}
	}
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return nil, &timelinesources.Error{Kind: timelinesources.KindPreconditionFailed, Reason: MaterializeErrorResourceNotReady, Message: "时间线素材尚未就绪"}
	}
	return resource, nil
}

func (s *Service) resolveTimelineRenderSources(userID string, req *TimelineRenderCreateRequest) ([]editing.SourceMeta, error) {
	if req.Timeline.Version != editing.ProjectVersion || len(req.Timeline.Clips) == 0 {
		return nil, nil
	}
	var ports timelinesources.Ports
	switch {
	case s.deps.TimelineSources != nil:
		ports = timelinesources.Ports{
			Canvas:    s.deps.TimelineSources,
			Resources: s.deps.TimelineSources,
			Assets:    s.deps.TimelineSources,
		}
	case s.deps.OwnedMedia != nil:
		ports = timelinesources.Ports{
			Resources: ownedMediaReadyLookup{media: s.deps.OwnedMedia},
		}
	}
	var doc map[string]any
	if projectID := strings.TrimSpace(req.ProjectID); projectID != "" && ports.Canvas != nil {
		raw, err := ports.Canvas.UserCanvasProject(userID, projectID)
		if err != nil {
			if !isCanvasNotFound(err) {
				return nil, mapTimelineRenderSourceError(err)
			}
		} else if len(raw) > 0 {
			if err := json.Unmarshal(raw, &doc); err != nil {
				return nil, kernel.BadAuthRequest("画布文档无法读取")
			}
		}
	}
	sources, err := timelinesources.Resolve(userID, doc, &req.Timeline, ports, timelinesources.Options{
		RequireCanvasDocumentMembership: false,
		RequireAssetLink:                false,
	})
	if err != nil {
		return nil, mapTimelineRenderSourceError(err)
	}
	return sources, nil
}

func isCanvasNotFound(err error) bool {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return true
	}
	var appErr *kernel.AppError
	return errors.As(err, &appErr) && appErr.Status == http.StatusNotFound
}

func mapTimelineRenderSourceError(err error) error {
	var tsErr *timelinesources.Error
	if errors.As(err, &tsErr) {
		status := http.StatusBadRequest
		switch tsErr.Kind {
		case timelinesources.KindPermissionDenied:
			status = http.StatusForbidden
		case timelinesources.KindPreconditionFailed:
			status = http.StatusPreconditionFailed
		}
		return &kernel.AppError{Status: status, Code: status, Reason: kernel.ErrorReason(tsErr.Reason), Message: tsErr.Message}
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	return kernel.BadAuthRequest(err.Error())
}
