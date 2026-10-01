package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/gorm"
)

func (s *Service) DeliverSucceededTask(task model.Task) error {
	if strings.TrimSpace(task.ID) == "" || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	outputs := localtask.CanonicalOutputs(task.ResultJSON)
	if len(outputs) == 0 {
		return nil
	}
	binding := localtask.TargetBindingFromInput(task.InputJSON)
	existing, err := s.repo.AssetRepresentationsForTask(task.ID)
	if err != nil {
		return err
	}
	existingByRole := map[string]model.AssetRepresentation{}
	for _, representation := range existing {
		existingByRole[representation.Role] = representation
	}
	now := time.Now()
	items := make([]repository.GenerationDeliveryItem, 0, len(outputs))
	for _, output := range outputs {
		output = localtask.BindOutput(output, task.ID, binding)
		item, itemErr := s.generationDeliveryItem(task, output, existingByRole[localtask.OutputRole(output.OutputIndex)], now)
		if itemErr != nil {
			return itemErr
		}
		items = append(items, item)
	}
	return s.repo.UpsertGenerationDelivery(items)
}

func (s *Service) ensureSucceededTaskDelivery(task *model.Task) error {
	if task == nil || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	stored, err := s.loadedCanonicalOutputs(task.ID)
	if err != nil {
		return err
	}
	if localtask.DeliveryComplete(task.ResultJSON, stored) {
		return nil
	}
	return s.DeliverSucceededTask(*task)
}

func (s *Service) loadedCanonicalOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	results, err := s.repo.GenerationOutputResults(taskID)
	if err != nil {
		return nil, err
	}
	return decodeGenerationOutputs(results), nil
}

func (s *Service) attachTaskDelivery(task *model.Task) {
	if task == nil {
		return
	}
	outputs := s.projectedCanonicalOutputs(*task)
	task.Outputs = modelTaskOutputs(outputs)
	task.ResultState = localtask.ResultState(task.Status, outputs, persistedFailureBlocksRetry(task.Error, task.Stage))
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
	results, err := s.repo.GenerationOutputResultsForTasks(ids)
	if err != nil {
		return
	}
	byTask := map[string][]localtask.CanonicalOutput{}
	for _, result := range results {
		output, decodeErr := localtask.DecodeOutputPayload(result.Payload)
		if decodeErr != nil {
			continue
		}
		byTask[result.TaskID] = append(byTask[result.TaskID], output)
	}
	for index := range summaries {
		task, ok := taskByID[summaries[index].ID]
		if !ok {
			continue
		}
		outputs := mergeCanonicalOutputs(task, byTask[task.ID])
		summaries[index].Outputs = outputs
		summaries[index].ResultState = localtask.ResultState(task.Status, outputs, persistedFailureBlocksRetry(task.Error, task.Stage))
	}
}

func (s *Service) projectedCanonicalOutputs(task model.Task) []localtask.CanonicalOutput {
	stored, err := s.loadedCanonicalOutputs(task.ID)
	if err != nil {
		stored = nil
	}
	return mergeCanonicalOutputs(task, stored)
}

func mergeCanonicalOutputs(task model.Task, stored []localtask.CanonicalOutput) []localtask.CanonicalOutput {
	parsed := localtask.CanonicalOutputs(task.ResultJSON)
	binding := localtask.TargetBindingFromInput(task.InputJSON)
	if len(parsed) == 0 {
		if len(stored) == 0 {
			return nil
		}
		parsed = stored
	}
	byIndex := map[int]localtask.CanonicalOutput{}
	for _, output := range stored {
		byIndex[output.OutputIndex] = output
	}
	merged := make([]localtask.CanonicalOutput, 0, len(parsed))
	for _, output := range parsed {
		if got, ok := byIndex[output.OutputIndex]; ok {
			output = got
		}
		merged = append(merged, localtask.BindOutput(output, task.ID, binding))
	}
	return merged
}

func decodeGenerationOutputs(results []model.Result) []localtask.CanonicalOutput {
	outputs := make([]localtask.CanonicalOutput, 0, len(results))
	for _, result := range results {
		output, err := localtask.DecodeOutputPayload(result.Payload)
		if err != nil {
			continue
		}
		outputs = append(outputs, output)
	}
	return outputs
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

func (s *Service) generationDeliveryItem(task model.Task, output localtask.CanonicalOutput, existing model.AssetRepresentation, now time.Time) (repository.GenerationDeliveryItem, error) {
	payload, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return repository.GenerationDeliveryItem{}, err
	}
	item := repository.GenerationDeliveryItem{
		Result: model.Result{
			ID:        localtask.OutputResultID(task.ID, output.OutputIndex),
			UserID:    task.UserID,
			TaskID:    task.ID,
			Kind:      localtask.ResultKindGenerationOutput,
			Payload:   payload,
			CreatedAt: now,
		},
	}
	if output.ResourceID != "" {
		item.Result.URL = assets.FileURL(output.ResourceID)
	}
	if strings.TrimSpace(output.ResourceID) == "" {
		return item, nil
	}
	if existing.ID != "" {
		return s.bindExistingGenerationOutput(task, output, existing, item)
	}
	resource, resourceErr := s.generationOutputResource(task.UserID, output.ResourceID)
	if resource == nil {
		if resourceErr != nil && !knownGenerationResourceError(resourceErr) {
			return repository.GenerationDeliveryItem{}, resourceErr
		}
		output.MaterializationErrorCode = materializationErrorCode(resourceErr)
		encoded, encodeErr := localtask.EncodeOutputPayload(output)
		if encodeErr != nil {
			return repository.GenerationDeliveryItem{}, encodeErr
		}
		item.Result.Payload = encoded
		return item, nil
	}
	if localtask.HasWorkflowOutputIntent(task.InputJSON) {
		return item, nil
	}

	assetID := localtask.MaterializedAssetID(task.ID, output.OutputIndex)
	versionID := localtask.OutputVersionID(task.ID, output.OutputIndex)
	representationID := localtask.OutputRepresentationID(task.ID, output.OutputIndex)

	output.MaterializedAssetID = assetID
	output.MaterializationErrorCode = ""
	encoded, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return repository.GenerationDeliveryItem{}, err
	}
	item.Result.Payload = encoded
	assetPayload, err := generationAssetPayload(task, output, *resource, assetID, versionID, now)
	if err != nil {
		return repository.GenerationDeliveryItem{}, err
	}
	metadata, err := json.Marshal(output)
	if err != nil {
		return repository.GenerationDeliveryItem{}, err
	}
	item.Asset = &model.Asset{
		ID:               assetID,
		UserID:           task.UserID,
		Kind:             output.MediaType,
		Category:         model.AssetCategoryMaterial,
		Status:           model.AssetVersionStatusConfirmed,
		PrimaryVersionID: versionID,
		Title:            generationAssetTitle(output.MediaType),
		PayloadJSON:      assetPayload,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	item.Version = &model.AssetVersion{
		ID:             versionID,
		AssetID:        assetID,
		Version:        1,
		Status:         model.AssetVersionStatusConfirmed,
		DefinitionJSON: "{}",
		Prompt:         task.Prompt,
		Note:           "生成任务产物",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	item.Representation = &model.AssetRepresentation{
		ID:             representationID,
		TaskID:         task.ID,
		AssetVersionID: versionID,
		ResourceID:     resource.ID,
		MediaType:      output.MediaType,
		Role:           localtask.OutputRole(output.OutputIndex),
		MetadataJSON:   string(metadata),
		CreatedAt:      now,
	}
	return item, nil
}

func (s *Service) bindExistingGenerationOutput(task model.Task, output localtask.CanonicalOutput, existing model.AssetRepresentation, item repository.GenerationDeliveryItem) (repository.GenerationDeliveryItem, error) {
	if existing.AssetVersionID != "" {
		if version, versionErr := s.repo.AssetVersion(existing.AssetVersionID); versionErr == nil && version != nil {
			if asset, assetErr := s.repo.AssetForUser(task.UserID, version.AssetID); assetErr == nil && asset != nil {
				output.MaterializedAssetID = asset.ID
				output.MaterializationErrorCode = ""
			}
		}
	}
	encoded, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return repository.GenerationDeliveryItem{}, err
	}
	item.Result.Payload = encoded
	return item, nil
}

func (s *Service) generationOutputResource(userID, resourceID string) (*model.Resource, error) {
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, errGenerationResourceMissing
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err == nil {
		if resource.Status != model.ResourceStatusReady {
			return nil, errGenerationResourceNotReady
		}
		return resource, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if _, lookupErr := s.repo.Resource(resourceID); lookupErr == nil {
		return nil, errGenerationResourceForeign
	}
	return nil, errGenerationResourceMissing
}

func knownGenerationResourceError(err error) bool {
	return errors.Is(err, errGenerationResourceMissing) || errors.Is(err, errGenerationResourceNotReady) || errors.Is(err, errGenerationResourceForeign)
}

func materializationErrorCode(err error) string {
	switch {
	case errors.Is(err, errGenerationResourceForeign):
		return localtask.MaterializeErrorResourceForeign
	case errors.Is(err, errGenerationResourceNotReady):
		return localtask.MaterializeErrorResourceNotReady
	case errors.Is(err, errGenerationResourceMissing):
		return localtask.MaterializeErrorResourceMissing
	default:
		return localtask.MaterializeErrorPersistFailed
	}
}

func generationAssetTitle(mediaType string) string {
	switch mediaType {
	case "video":
		return "生成视频"
	case "audio":
		return "生成音频"
	default:
		return "生成图片"
	}
}

func generationAssetPayload(task model.Task, output localtask.CanonicalOutput, resource model.Resource, assetID, versionID string, now time.Time) (string, error) {
	resourceURL := assets.FileURL(resource.ID)
	width := resource.Width
	height := resource.Height
	if width <= 0 {
		width = 1
	}
	if height <= 0 {
		height = 1
	}
	data := map[string]any{
		"storageKey": "resource:" + resource.ID,
		"mimeType":   resource.MimeType,
		"bytes":      resource.Size,
		"width":      width,
		"height":     height,
	}
	if output.MediaType == "image" {
		data["dataUrl"] = resourceURL
	} else {
		data["url"] = resourceURL
		if resource.DurationMs > 0 {
			data["durationMs"] = resource.DurationMs
		}
	}
	metadata := map[string]any{
		"source":              "generation-task",
		"generationEffectKey": output.EffectKey,
		"taskId":              task.ID,
		"outputIndex":         output.OutputIndex,
	}
	if output.TargetBinding != nil {
		if output.TargetBinding.ConversationID != "" {
			metadata["conversationId"] = output.TargetBinding.ConversationID
		}
		if output.TargetBinding.MessageID != "" {
			metadata["messageId"] = output.TargetBinding.MessageID
		}
		if output.TargetBinding.NodeID != "" {
			metadata["nodeId"] = output.TargetBinding.NodeID
		}
	}
	payload, err := json.Marshal(map[string]any{
		"id":               assetID,
		"kind":             output.MediaType,
		"category":         model.AssetCategoryMaterial,
		"status":           model.AssetVersionStatusConfirmed,
		"primaryVersionId": versionID,
		"title":            generationAssetTitle(output.MediaType),
		"coverUrl":         resourceURL,
		"tags":             []string{"生成"},
		"source":           "生成任务",
		"createdAt":        now.UTC().Format(time.RFC3339Nano),
		"updatedAt":        now.UTC().Format(time.RFC3339Nano),
		"data":             data,
		"metadata":         metadata,
	})
	if err != nil {
		return "", fmt.Errorf("序列化生成素材失败：%w", err)
	}
	return string(payload), nil
}

var (
	errGenerationResourceMissing  = errors.New("generation resource missing")
	errGenerationResourceNotReady = errors.New("generation resource not ready")
	errGenerationResourceForeign  = errors.New("generation resource belongs to another user")
)
