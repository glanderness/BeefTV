package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskdelivery"

	"gorm.io/gorm"
)

const generationDeliveryRecoveryInterval = 5 * time.Second

func (s *Service) DeliverSucceededTask(task model.Task) error {
	err := s.generationDeliverer().Deliver(task)
	if bindErr := s.recoverCanvasTaskBindings(task); bindErr != nil {
		log.Printf("generation canvas bind deferred: task_id=%s error=%v", task.ID, bindErr)
	}
	return err
}

func (s *Service) RecoverIncompleteGenerationDeliveries(limit int) error {
	err := s.generationDeliverer().RecoverIncomplete(limit)
	if bindErr := s.recoverPendingCanvasBindings(limit); bindErr != nil {
		log.Printf("generation canvas bind recovery paused: worker_id=%s error=%v", s.workerID, bindErr)
	}
	return err
}

func (s *Service) CanvasBindingIntents(task model.Task) []localtask.CanvasBindingIntent {
	stored, loadErr := s.generationDeliverer().LoadedOutputs(task.ID)
	proj := taskdelivery.Project(task, stored, loadErr, persistedFailureBlocksRetry(task.Error, task.Stage))
	return localtask.CanvasBindingIntents(task.ID, proj.Outputs)
}

func (s *Service) ensureSucceededTaskDelivery(task *model.Task) error {
	if task == nil || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	stored, err := s.generationDeliverer().LoadedOutputs(task.ID)
	if err != nil {
		return err
	}
	if localtask.DeliveryComplete(task.ResultJSON, stored) {
		return nil
	}
	return s.DeliverSucceededTask(*task)
}

func (s *Service) attachTaskDelivery(task *model.Task) {
	if task == nil {
		return
	}
	stored, loadErr := s.generationDeliverer().LoadedOutputs(task.ID)
	proj := taskdelivery.Project(*task, stored, loadErr, persistedFailureBlocksRetry(task.Error, task.Stage))
	task.Outputs = modelTaskOutputs(proj.Outputs)
	task.ResultState = proj.ResultState
}

func (s *Service) attachTaskSummaryDeliveries(tasks []model.Task, summaries []TaskSummary) {
	if len(tasks) == 0 || len(summaries) == 0 {
		return
	}
	ids := make([]string, 0, len(tasks))
	taskByID := make(map[string]model.Task, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
		taskByID[task.ID] = task
	}
	byTask, decodeErrs, loadErr := s.generationDeliverer().LoadedOutputsForTasks(ids)
	for index := range summaries {
		task, ok := taskByID[summaries[index].ID]
		if !ok {
			continue
		}
		taskLoadErr := loadErr
		if taskLoadErr == nil {
			taskLoadErr = decodeErrs[task.ID]
		}
		proj := taskdelivery.Project(task, byTask[task.ID], taskLoadErr, persistedFailureBlocksRetry(task.Error, task.Stage))
		summaries[index].Outputs = proj.Outputs
		summaries[index].ResultState = proj.ResultState
	}
}

func (s *Service) attachRecoveredProviderTask(task *model.Task) *model.Task {
	if task == nil {
		return nil
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "任务恢复成功但结果交付失败", err.Error())
	}
	projected := taskForOutput(*task)
	s.attachTaskDelivery(projected)
	return projected
}

func (s *Service) startGenerationDeliveryRecovery(context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		recoverOnce := func() {
			if ctx.Err() != nil || s.IsDraining() {
				return
			}
			if err := s.RecoverIncompleteGenerationDeliveries(0); err != nil {
				log.Printf("generation delivery recovery paused: worker_id=%s error=%v", s.workerID, err)
			}
		}
		recoverOnce()
		ticker := time.NewTicker(generationDeliveryRecoveryInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				recoverOnce()
			}
		}
	})
}

func (s *Service) generationDeliverer() *taskdelivery.Deliverer {
	if s == nil {
		return taskdelivery.New(generationDeliveryStore{}, nil)
	}
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	if s.generationDelivery == nil {
		// One Deliverer per Service so recovery ticks keep the keyset cursor.
		s.generationDelivery = taskdelivery.New(generationDeliveryStore{repo: s.repo}, s.deliveryMedia())
	}
	return s.generationDelivery
}

func (s *Service) deliveryMedia() taskdelivery.Media {
	if s != nil && s.generationDeliveryMedia != nil {
		return s.generationDeliveryMedia
	}
	if s == nil || (s.platform == nil && strings.TrimSpace(s.dataDir) == "") {
		return nil
	}
	return generationDeliveryMediaAdapter{service: s}
}

func modelTaskOutputs(outputs []localtask.CanonicalOutput) []model.TaskOutput {
	if len(outputs) == 0 {
		return nil
	}
	result := make([]model.TaskOutput, 0, len(outputs))
	for _, output := range outputs {
		item := model.TaskOutput{
			OutputIndex:              output.OutputIndex,
			MediaType:                output.MediaType,
			ProviderArtifactRef:      output.ProviderArtifactRef,
			MaterializedAssetID:      output.MaterializedAssetID,
			MaterializationErrorCode: output.MaterializationErrorCode,
			ResourceID:               output.ResourceID,
			EffectKey:                output.EffectKey,
		}
		if output.TargetBinding != nil && !output.TargetBinding.Empty() {
			item.TargetBinding = &model.TaskOutputTarget{
				NodeID:         output.TargetBinding.NodeID,
				MessageID:      output.TargetBinding.MessageID,
				ConversationID: output.TargetBinding.ConversationID,
				Source:         output.TargetBinding.Source,
			}
		}
		result = append(result, item)
	}
	return result
}

type generationDeliveryStore struct {
	repo *repository.Repository
}

func (s generationDeliveryStore) WithTx(fn func(taskdelivery.Store) error) error {
	if s.repo == nil {
		return errors.New("generation delivery store is not initialized")
	}
	return s.repo.Transaction(func(tx *repository.Repository) error {
		return fn(generationDeliveryStore{repo: tx})
	})
}

func (s generationDeliveryStore) GenerationOutputResults(taskID string) ([]model.Result, error) {
	return s.repo.GenerationOutputResults(taskID)
}

func (s generationDeliveryStore) GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error) {
	return s.repo.GenerationOutputResultsForTasks(taskIDs)
}

func (s generationDeliveryStore) AssetRepresentationsForTask(taskID string) ([]model.AssetRepresentation, error) {
	return s.repo.AssetRepresentationsForTask(taskID)
}

func (s generationDeliveryStore) ResourceForUser(userID, id string) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, id)
	return resource, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) Resource(id string) (*model.Resource, error) {
	resource, err := s.repo.Resource(id)
	return resource, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) Asset(id string) (*model.Asset, error) {
	asset, err := s.repo.Asset(id)
	return asset, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) AssetVersion(id string) (*model.AssetVersion, error) {
	version, err := s.repo.AssetVersion(id)
	return version, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) CommitOwned(item taskdelivery.OwnedDelivery) error {
	return mapDeliveryStoreErr(s.repo.CommitOwnedGenerationDelivery(repository.GenerationDeliveryItem{
		Result:         item.Result,
		Asset:          item.Asset,
		Version:        item.Version,
		Representation: item.Representation,
	}))
}

func (s generationDeliveryStore) SucceededTasksForDelivery(afterID string, limit int) ([]model.Task, error) {
	return s.repo.SucceededTasksForDelivery(afterID, limit)
}

func mapDeliveryStoreErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return taskdelivery.ErrNotFound
	}
	if errors.Is(err, repository.ErrAssetOwnedByAnotherUser) {
		return taskdelivery.ErrForeignAsset
	}
	return err
}

type generationDeliveryMediaAdapter struct {
	service *Service
}

func (a generationDeliveryMediaAdapter) PersistRemoteArtifact(userID, mediaType, artifactURL, identity string) (*model.Resource, error) {
	if a.service == nil {
		return nil, errors.New("generation media adapter is not initialized")
	}
	userID = strings.TrimSpace(userID)
	artifactURL = strings.TrimSpace(artifactURL)
	identity = strings.TrimSpace(identity)
	if userID == "" || artifactURL == "" || identity == "" {
		return nil, fmt.Errorf("generation artifact identity is incomplete")
	}
	return a.service.resourceDomain().RecoverOwned(userID, identity, func() (localasset.RecoveredArtifact, error) {
		kind, data, mimeType, fileName, width, height, durationMs, err := a.decodeGenerationArtifact(mediaType, artifactURL)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		return localasset.RecoveredArtifact{
			Kind: kind, FileName: fileName, MimeType: mimeType,
			Size: int64(len(data)), Width: width, Height: height, DurationMs: durationMs,
			Body: bytes.NewReader(data),
		}, nil
	})
}

func (a generationDeliveryMediaAdapter) decodeGenerationArtifact(mediaType, artifactURL string) (kind string, data []byte, mimeType, fileName string, width, height int, durationMs int64, err error) {
	kind = strings.TrimSpace(mediaType)
	switch {
	case strings.HasPrefix(artifactURL, "data:"):
		decodedType, decoded, decodeErr := a.service.decodeDataURL(artifactURL)
		if decodeErr != nil {
			return "", nil, "", "", 0, 0, 0, decodeErr
		}
		mimeType, data = decodedType, decoded
		kind = normalizeResourceKind(kind, mimeType)
		fileName = "generated." + extensionFromMimeType(mimeType)
		if kind == "image" {
			width, height = imageDimensions(data)
		}
		if kind == "video" {
			width, height, durationMs = probeGeneratedVideoMedia(data)
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	case strings.HasPrefix(artifactURL, "http://") || strings.HasPrefix(artifactURL, "https://"):
		policy, policyErr := a.service.RuntimePolicy()
		if policyErr != nil {
			return "", nil, "", "", 0, 0, 0, policyErr
		}
		payload, downloadErr := downloadRemoteResource(artifactURL, megabytes(policy.Resource.GeneratedFileMB)+1)
		if downloadErr != nil {
			return "", nil, "", "", 0, 0, 0, downloadErr
		}
		mimeType, data = payload.mimeType, payload.data
		kind = normalizeResourceKind(kind, mimeType)
		fileName = payload.fileName
		if kind == "image" {
			width, height = imageDimensions(data)
		}
		if kind == "video" {
			probedWidth, probedHeight, probedDurationMs := probeGeneratedVideoMedia(data)
			if width <= 0 {
				width = probedWidth
			}
			if height <= 0 {
				height = probedHeight
			}
			if durationMs <= 0 {
				durationMs = probedDurationMs
			}
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	default:
		return "", nil, "", "", 0, 0, 0, fmt.Errorf("unsupported generation artifact %q", artifactURL)
	}
}

// generationLocalArtifactPresent checks the same FileStore path storeResourceObject
// writes. asset.Service.validateLocalResource and any future Retry lock stay in
// the resource-worker domain; this adapter does not edit that package.
func (s *Service) generationLocalArtifactPresent(resource *model.Resource) bool {
	if s == nil || resource == nil || strings.TrimSpace(resource.ObjectKey) == "" {
		return false
	}
	body, err := localasset.NewFileStore(s.dataDir).Open(resource.ObjectKey)
	if err != nil {
		return false
	}
	_ = body.Close()
	return true
}
