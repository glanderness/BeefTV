package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const (
	canvasFolderNameMaxRunes  = 80
	canvasDrawingIDMaxRunes   = 80
	canvasDrawingSnapshotMax  = 8 << 20
	canvasDrawingEngineExcal  = "excalidraw"
	canvasDrawingDefaultPages = 1
)

type CanvasDrawingRender struct {
	ResourceID string `json:"resourceId,omitempty"`
	PageID     string `json:"pageId,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	MimeType   string `json:"mimeType,omitempty"`
	Background string `json:"background,omitempty"`
	StorageKey string `json:"storageKey,omitempty"`
}

type CanvasDrawingDocument struct {
	DrawingID         string               `json:"drawingId"`
	Engine            string               `json:"engine"`
	Revision          int64                `json:"revision"`
	Snapshot          json.RawMessage      `json:"snapshot,omitempty"`
	ShapeCount        int                  `json:"shapeCount"`
	PageCount         int                  `json:"pageCount"`
	PreviewResourceID string               `json:"previewResourceId,omitempty"`
	Render            *CanvasDrawingRender `json:"render,omitempty"`
	CreatedAt         time.Time            `json:"createdAt"`
	UpdatedAt         time.Time            `json:"updatedAt"`
}

func (s *Service) UserCanvasFolders(userID string) ([]model.CanvasLibraryFolder, error) {
	return s.repo.CanvasLibraryFolders(userID)
}

func (s *Service) UpsertUserCanvasFolder(userID string, id string, raw json.RawMessage) (model.CanvasLibraryFolder, error) {
	var payload struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		CoverResourceID string `json:"coverResourceId"`
		CreatedAt       string `json:"createdAt"`
		UpdatedAt       string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹数据格式错误")
	}
	folderID := strings.TrimSpace(id)
	if folderID == "" {
		folderID = strings.TrimSpace(payload.ID)
	}
	if folderID == "" {
		folderID = kernel.NewID()
	}
	if utf8.RuneCountInString(folderID) > 80 {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹 ID 无效")
	}
	if payload.ID != "" && strings.TrimSpace(payload.ID) != folderID {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹 ID 与请求路径不一致")
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		name = "未命名文件夹"
	}
	if utf8.RuneCountInString(name) > canvasFolderNameMaxRunes {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹名称过长")
	}
	coverID := strings.TrimSpace(payload.CoverResourceID)
	if err := s.ownedReadyResource(userID, coverID, "封面"); err != nil {
		return model.CanvasLibraryFolder{}, err
	}
	now := time.Now().UTC()
	folder := model.CanvasLibraryFolder{
		ID: folderID, UserID: userID, Name: name, CoverResourceID: coverID,
		CreatedAt: parseClientTime(payload.CreatedAt, now), UpdatedAt: now,
	}
	err := s.host.WithStorageLock(func() error {
		existing, existingErr := s.repo.CanvasLibraryFolderForUser(userID, folderID)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		if existing != nil {
			folder.CreatedAt = existing.CreatedAt
		}
		return s.repo.UpsertCanvasLibraryFolder(&folder)
	})
	if err != nil {
		return model.CanvasLibraryFolder{}, err
	}
	return folder, nil
}

func (s *Service) DeleteUserCanvasFolder(userID, id string) error {
	err := s.repo.DeleteCanvasLibraryFolder(userID, strings.TrimSpace(id))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.NotFound("文件夹不存在")
	}
	return err
}

func (s *Service) UserCanvasDrawings(userID, canvasID string) ([]CanvasDrawingDocument, error) {
	if _, err := s.ownedCanvas(userID, canvasID); err != nil {
		return nil, err
	}
	items, err := s.repo.CanvasDrawings(userID, canvasID)
	if err != nil {
		return nil, err
	}
	result := make([]CanvasDrawingDocument, 0, len(items))
	for _, item := range items {
		result = append(result, canvasDrawingDocument(item, false))
	}
	return result, nil
}

func (s *Service) UserCanvasDrawing(userID, canvasID, drawingID string) (CanvasDrawingDocument, error) {
	if _, err := s.ownedCanvas(userID, canvasID); err != nil {
		return CanvasDrawingDocument{}, err
	}
	item, err := s.repo.CanvasDrawingForUser(userID, canvasID, strings.TrimSpace(drawingID))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return CanvasDrawingDocument{}, kernel.NotFound("画板不存在")
	}
	if err != nil {
		return CanvasDrawingDocument{}, err
	}
	return canvasDrawingDocument(*item, true), nil
}

func (s *Service) UpsertUserCanvasDrawing(userID, canvasID, drawingID string, raw json.RawMessage) (CanvasDrawingDocument, error) {
	if len(raw) > canvasDrawingSnapshotMax+64<<10 {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板数据超过 8MB")
	}
	canvasRow, err := s.ownedCanvas(userID, canvasID)
	if err != nil {
		return CanvasDrawingDocument{}, err
	}
	var payload struct {
		DrawingID         string               `json:"drawingId"`
		Engine            string               `json:"engine"`
		Revision          *int64               `json:"revision"`
		Snapshot          json.RawMessage      `json:"snapshot"`
		ShapeCount        int                  `json:"shapeCount"`
		PageCount         int                  `json:"pageCount"`
		PreviewResourceID string               `json:"previewResourceId"`
		Render            *CanvasDrawingRender `json:"render"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板数据格式错误")
	}
	id := strings.TrimSpace(drawingID)
	if id == "" {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板 ID 无效")
	}
	if utf8.RuneCountInString(id) > canvasDrawingIDMaxRunes {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板 ID 无效")
	}
	if payload.DrawingID != "" && strings.TrimSpace(payload.DrawingID) != id {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板 ID 与请求路径不一致")
	}
	if payload.Revision == nil {
		return CanvasDrawingDocument{}, kernel.NewAppError(http.StatusPreconditionRequired, "缺少画板版本，请保留本地草稿后重新加载")
	}
	if *payload.Revision < 0 || *payload.Revision >= 9007199254740991 {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板版本无效")
	}
	engine := strings.TrimSpace(payload.Engine)
	if engine == "" {
		engine = canvasDrawingEngineExcal
	}
	if engine != canvasDrawingEngineExcal {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板引擎无效")
	}
	snapshot := payload.Snapshot
	if len(snapshot) == 0 {
		snapshot = json.RawMessage(`{}`)
	}
	if !json.Valid(snapshot) {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板数据格式错误")
	}
	if len(snapshot) > canvasDrawingSnapshotMax {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板数据超过 8MB")
	}
	previewID := strings.TrimSpace(payload.PreviewResourceID)
	if err := s.ownedReadyResource(userID, previewID, "画板预览"); err != nil {
		return CanvasDrawingDocument{}, err
	}
	render := payload.Render
	renderID := ""
	if render != nil {
		renderID = strings.TrimSpace(render.ResourceID)
		if err := s.ownedReadyResource(userID, renderID, "画板成品"); err != nil {
			return CanvasDrawingDocument{}, err
		}
		if render.Background != "" && render.Background != "white" {
			return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板成品背景无效")
		}
	}
	pageCount := payload.PageCount
	if pageCount <= 0 {
		pageCount = canvasDrawingDefaultPages
	}
	if pageCount > 1 {
		pageCount = 1
	}
	now := time.Now().UTC()
	row := model.CanvasDrawing{
		UserID: userID, CanvasID: canvasRow.ID, DrawingID: id, Engine: engine,
		Revision: *payload.Revision, SnapshotJSON: string(snapshot),
		ShapeCount: payload.ShapeCount, PageCount: pageCount,
		PreviewResourceID: previewID, CreatedAt: now, UpdatedAt: now,
	}
	if render != nil {
		row.RenderResourceID = renderID
		row.RenderPageID = strings.TrimSpace(render.PageID)
		row.RenderWidth = render.Width
		row.RenderHeight = render.Height
		row.RenderMimeType = strings.TrimSpace(render.MimeType)
		row.RenderBackground = strings.TrimSpace(render.Background)
		row.RenderStorageKey = strings.TrimSpace(render.StorageKey)
	}
	err = s.host.WithStorageLock(func() error {
		existing, existingErr := s.repo.CanvasDrawingForUser(userID, canvasRow.ID, id)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		if existing != nil {
			row.CreatedAt = existing.CreatedAt
			if render == nil {
				row.RenderResourceID = existing.RenderResourceID
				row.RenderPageID = existing.RenderPageID
				row.RenderWidth = existing.RenderWidth
				row.RenderHeight = existing.RenderHeight
				row.RenderMimeType = existing.RenderMimeType
				row.RenderBackground = existing.RenderBackground
				row.RenderStorageKey = existing.RenderStorageKey
			}
		}
		if (existing == nil && row.Revision != 0) || (existing != nil && row.Revision != existing.Revision) {
			return drawingRevisionConflict()
		}
		existingBytes := int64(0)
		if existing != nil {
			existingBytes = int64(len(existing.SnapshotJSON))
		}
		if err := s.host.StructuredQuota(userID, "canvas", errors.Is(existingErr, gorm.ErrRecordNotFound), int64(len(row.SnapshotJSON))-existingBytes); err != nil {
			return err
		}
		if err := s.repo.UpsertCanvasDrawing(&row); err != nil {
			if errors.Is(err, repository.ErrCanvasRevisionConflict) {
				return drawingRevisionConflict()
			}
			return err
		}
		return nil
	})
	if err != nil {
		return CanvasDrawingDocument{}, err
	}
	return canvasDrawingDocument(row, true), nil
}

func (s *Service) DeleteUserCanvasDrawing(userID, canvasID, drawingID string) error {
	if _, err := s.ownedCanvas(userID, canvasID); err != nil {
		return err
	}
	err := s.repo.DeleteCanvasDrawing(userID, canvasID, strings.TrimSpace(drawingID))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.NotFound("画板不存在")
	}
	return err
}

func (s *Service) ownedCanvas(userID, canvasID string) (*model.CanvasProject, error) {
	id := strings.TrimSpace(canvasID)
	if id == "" {
		return nil, kernel.BadAuthRequest("画布 ID 无效")
	}
	project, err := s.repo.CanvasProjectForUser(userID, id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, kernel.NotFound("画布不存在或无权访问")
	}
	if err != nil {
		return nil, err
	}
	return project, nil
}

func (s *Service) ownedReadyResource(userID, id, label string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.BadAuthRequest(label + "资源不存在")
	}
	if err != nil {
		return err
	}
	if resource.Status != model.ResourceStatusReady {
		return kernel.BadAuthRequest(label + "资源尚未就绪")
	}
	return nil
}

func (s *Service) requireCanvasLibraryFolder(userID, folderID string) error {
	folderID = strings.TrimSpace(folderID)
	if folderID == "" {
		return nil
	}
	_, err := s.repo.CanvasLibraryFolderForUser(userID, folderID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.BadAuthRequest("画布文件夹不存在")
	}
	return err
}

func canvasDrawingDocument(item model.CanvasDrawing, includeSnapshot bool) CanvasDrawingDocument {
	doc := CanvasDrawingDocument{
		DrawingID: item.DrawingID, Engine: item.Engine, Revision: item.Revision,
		ShapeCount: item.ShapeCount, PageCount: item.PageCount,
		PreviewResourceID: item.PreviewResourceID,
		CreatedAt:         item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
	if includeSnapshot && item.SnapshotJSON != "" {
		doc.Snapshot = json.RawMessage(item.SnapshotJSON)
	}
	if item.RenderResourceID != "" || item.RenderPageID != "" || item.RenderStorageKey != "" {
		doc.Render = &CanvasDrawingRender{
			ResourceID: item.RenderResourceID, PageID: item.RenderPageID,
			Width: item.RenderWidth, Height: item.RenderHeight,
			MimeType: item.RenderMimeType, Background: item.RenderBackground,
			StorageKey: item.RenderStorageKey,
		}
	}
	return doc
}

func drawingRevisionConflict() error {
	return kernel.NewAppError(http.StatusConflict, "画板已有更新，已停止覆盖；请保留本地草稿并加载最新版本")
}
