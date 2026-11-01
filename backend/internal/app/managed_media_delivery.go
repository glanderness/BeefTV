package app

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/outbound"
)

// A rejected signed storage URL can be refreshed only by reading the original
// API task. This never renews its retention or submits another generation.
func (a generationDeliveryMediaAdapter) refreshManagedArtifactURL(ctx context.Context, userID, identity, kind string, cause error) (string, bool, error) {
	var response *outbound.HTTPStatusError
	if !errors.As(cause, &response) || (response.StatusCode != 401 && response.StatusCode != 403) {
		return "", false, nil
	}
	taskID, rawIndex, ok := strings.Cut(identity, ":")
	index, err := strconv.Atoi(rawIndex)
	if !ok || err != nil || index < 0 {
		return "", false, errors.New("生成结果身份无效")
	}
	task, err := a.service.repo.TaskForUser(userID, taskID)
	if err != nil {
		return "", false, err
	}
	query, managed, err := a.service.managedTaskRecoveryQuery(ctx, *task)
	if err != nil || !managed {
		return "", managed, err
	}
	if query.Legacy {
		return "", false, nil
	}
	query.Client.AllowHTTPTest = a.allowManagedMediaHTTPForTest
	ctx = context.WithValue(ctx, imageTaskContext{}, *task)
	projection, err := query.Client.Query(ctx, query.Key, query.Kind)
	if err != nil {
		return "", true, err
	}
	if projection.Status != "completed" || index >= len(projection.Outputs) || projection.Outputs[index].Kind != kind || projection.Outputs[index].URL == "" {
		return "", true, errors.New("原任务结果暂不可用，请稍后继续取回")
	}
	return projection.Outputs[index].URL, true, nil
}

func (a generationDeliveryMediaAdapter) restoreManagedUpscaleAudio(ctx context.Context, userID, identity string, data []byte) ([]byte, error) {
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, errors.New("生成结果身份无效")
	}
	task, err := a.service.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	plain, err := a.service.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input generation.Input
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return nil, err
	}
	if input.Upscale == nil || input.Mode != "video" {
		return data, nil
	}
	ctx = a.service.bindGenerationRuntime(ctx, generation.CallMeta{UserID: userID, TaskID: taskID, TaskType: task.Type})
	return generation.RestoreUpscaleSourceAudio(ctx, input, data)
}
