package app

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
)

type UpdateWorkflowStepRequest = localproject.UpdateWorkflowStepRequest
type RegisterTaskOutputRequest = localproject.RegisterTaskOutputRequest

func (s *Service) EnsureBuiltinProjectWorkflowTemplate() error {
	return s.projectDomain().EnsureBuiltinTemplate()
}

func (s *Service) ProjectWorkflows(projectID string) ([]ProjectWorkflowDetail, error) {
	instances, err := s.repo.ProjectWorkflowInstances(projectID)
	if err != nil {
		return nil, err
	}
	result := make([]ProjectWorkflowDetail, 0, len(instances))
	for _, instance := range instances {
		steps, stepsErr := s.repo.WorkflowSteps(instance.ID)
		if stepsErr != nil {
			return nil, stepsErr
		}
		result = append(result, ProjectWorkflowDetail{Instance: instance, Steps: steps})
	}
	return result, nil
}

func (s *Service) CreateUnitWorkflow(userID string, projectID string, unitID string) (ProjectWorkflowDetail, error) {
	return s.projectDomain().CreateUnitWorkflow(userID, projectID, unitID)
}

func (s *Service) UpdateWorkflowStep(userID string, projectID string, stepID string, req UpdateWorkflowStepRequest) (model.WorkflowStepInstance, error) {
	return s.projectDomain().UpdateWorkflowStep(userID, projectID, stepID, req)
}

func (s *Service) RegisterTaskOutput(userID string, projectID string, stepID string, req RegisterTaskOutputRequest) (model.WorkflowStepInstance, error) {
	return s.projectDomain().RegisterTaskOutput(userID, projectID, stepID, req)
}

func (s *Service) RegisterTaskOutputFromTask(task model.Task) error {
	if strings.TrimSpace(task.ProjectID) == "" || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	if strings.TrimSpace(task.InputJSON) == "" {
		return nil
	}
	decrypted, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return err
	}
	var input struct {
		WorkflowStepID  string         `json:"workflowStepId"`
		DomainProjectID string         `json:"domainProjectId"`
		CanvasID        string         `json:"canvasId"`
		UnitID          string         `json:"unitId"`
		ShotID          string         `json:"shotId"`
		ShotRevisionID  string         `json:"shotRevisionId"`
		ArtifactType    string         `json:"artifactType"`
		AssetVersionID  string         `json:"assetVersionId"`
		ResourceID      string         `json:"resourceId"`
		MediaType       string         `json:"mediaType"`
		Role            string         `json:"role"`
		MetadataJSON    string         `json:"metadataJson"`
		Metadata        map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(decrypted), &input); err != nil {
		return err
	}
	if input.Metadata != nil {
		if input.WorkflowStepID == "" {
			input.WorkflowStepID, _ = input.Metadata["workflowStepId"].(string)
		}
		if input.DomainProjectID == "" {
			input.DomainProjectID, _ = input.Metadata["domainProjectId"].(string)
		}
		if input.AssetVersionID == "" {
			input.AssetVersionID, _ = input.Metadata["assetVersionId"].(string)
		}
		if input.CanvasID == "" {
			input.CanvasID, _ = input.Metadata["canvasId"].(string)
		}
		if input.UnitID == "" {
			input.UnitID, _ = input.Metadata["unitId"].(string)
		}
		if input.ShotID == "" {
			input.ShotID, _ = input.Metadata["shotId"].(string)
		}
		if input.ShotRevisionID == "" {
			input.ShotRevisionID, _ = input.Metadata["shotRevisionId"].(string)
		}
		if input.ArtifactType == "" {
			input.ArtifactType, _ = input.Metadata["artifactType"].(string)
		}
		if input.ResourceID == "" {
			input.ResourceID, _ = input.Metadata["resourceId"].(string)
		}
		if input.MediaType == "" {
			input.MediaType, _ = input.Metadata["mediaType"].(string)
		}
		if input.Role == "" {
			input.Role, _ = input.Metadata["role"].(string)
		}
		if input.MetadataJSON == "" {
			if artifactMetadata, ok := input.Metadata["artifactMetadata"]; ok {
				if encoded, encodeErr := json.Marshal(artifactMetadata); encodeErr == nil {
					input.MetadataJSON = string(encoded)
				}
			}
		}
	}
	if strings.TrimSpace(input.ResourceID) == "" {
		input.ResourceID, input.MediaType = taskOutputResource(task.ResultJSON, task.Type)
	}
	if strings.TrimSpace(input.MediaType) == "" && strings.TrimSpace(input.ResourceID) != "" {
		input.MediaType = taskOutputMediaType(task.Type)
	}
	if strings.TrimSpace(input.WorkflowStepID) == "" {
		return nil
	}
	projectID := strings.TrimSpace(input.DomainProjectID)
	if projectID == "" {
		if _, projectErr := s.projectDomain().Owned(task.UserID, task.ProjectID); projectErr == nil {
			projectID = task.ProjectID
		}
	}
	if projectID == "" {
		return errors.New("任务未提供短剧项目 ID，无法登记产物")
	}
	if strings.TrimSpace(input.ResourceID) != "" && strings.TrimSpace(input.AssetVersionID) == "" && strings.TrimSpace(input.ShotID) != "" {
		assetVersionID, assetErr := s.projectDomain().EnsureGeneratedProjectAsset(task.UserID, projectID, task.ID, input.ShotID, input.ResourceID, input.MediaType, task.Prompt)
		if assetErr != nil {
			return assetErr
		}
		input.AssetVersionID = assetVersionID
	}
	_, err = s.projectDomain().RegisterTaskOutput(task.UserID, projectID, input.WorkflowStepID, localproject.RegisterTaskOutputRequest{
		TaskID: task.ID, CanvasID: input.CanvasID, UnitID: input.UnitID, ShotID: input.ShotID, ShotRevisionID: input.ShotRevisionID,
		ArtifactType: input.ArtifactType, AssetVersionID: input.AssetVersionID, ResourceID: input.ResourceID, MediaType: input.MediaType,
		Role: input.Role, MetadataJSON: input.MetadataJSON, OutputJSON: task.ResultJSON,
	})
	return err
}

func taskOutputMediaType(taskType string) string {
	if strings.Contains(strings.ToLower(taskType), "video") {
		return "video"
	}
	return "image"
}

func taskOutputResource(raw string, taskType string) (string, string) {
	if strings.TrimSpace(raw) == "" {
		return "", ""
	}
	var value any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return "", ""
	}
	return findTaskOutputResource(value, taskOutputMediaType(taskType))
}

func findTaskOutputResource(value any, mediaType string) (string, string) {
	switch item := value.(type) {
	case []any:
		for _, child := range item {
			if id, kind := findTaskOutputResource(child, mediaType); id != "" {
				return id, kind
			}
		}
	case map[string]any:
		for _, key := range []string{"resourceId", "storageKey", "url", "dataUrl", "resultUrl", "outputUrl"} {
			if raw, ok := item[key].(string); ok {
				text := strings.TrimSpace(raw)
				if strings.HasPrefix(text, "resource:") {
					return strings.TrimPrefix(text, "resource:"), mediaType
				}
				if id := resourceIDFromFileURL(text); id != "" {
					return id, mediaType
				}
			}
		}
		for _, child := range item {
			if id, kind := findTaskOutputResource(child, mediaType); id != "" {
				return id, kind
			}
		}
	}
	return "", ""
}

func workflowGeneratedEntityID(namespace string, taskID string) string {
	return localproject.GeneratedEntityID(namespace, taskID)
}
