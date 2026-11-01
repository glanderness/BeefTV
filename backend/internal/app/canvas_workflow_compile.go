package app

import (
	"encoding/json"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/workspace"
)

// Recipe types keep their historical names for tests. Stored JSON field names
// are the exported Go names, unchanged from the previous private types.
type workflowBinding = cw.Binding
type workflowRecipe = cw.Recipe
type workflowRecipes = cw.RecipesByNode

func workflowMediaField(kind string) string { return cw.MediaField(kind) }

func (s *Service) compileHost() cw.CompileHost { return workflowCompileHost{s} }

func (s *Service) compileCanvasWorkflow(user string, d cw.Definition, existing ...model.CanvasWorkflow) (workflowRecipes, map[string]bool, error) {
	var saved *model.CanvasWorkflow
	if len(existing) > 0 {
		saved = &existing[0]
	}
	compiled, err := cw.Compile(s.compileHost(), user, d, saved)
	if err != nil {
		return nil, nil, err
	}
	return compiled.Recipes, compiled.References, nil
}

func (s *Service) materializeCanvasWorkflowRequest(user, operation string, recipe workflowRecipe, nodes map[string]cw.Node, steps map[string]*cw.Step) (CreateTaskRequest, error) {
	request, err := cw.Materialize(s.compileHost(), user, operation, recipe, nodes, steps)
	return createTaskRequestFromRecipe(request), err
}

func createTaskRequestFromRecipe(request cw.RecipeRequest) CreateTaskRequest {
	return CreateTaskRequest{
		ProjectID:      request.ProjectID,
		Type:           request.Type,
		Operation:      request.Operation,
		Prompt:         request.Prompt,
		Provider:       request.Provider,
		Model:          request.Model,
		LogicalModelID: request.LogicalModelID,
		Input:          request.Input,
	}
}

// workflowCompileHost is the app side of recipe compilation: secrets, the
// local provider snapshot, and the checks that stay next to task admission.
type workflowCompileHost struct{ s *Service }

func (h workflowCompileHost) DecryptSetting(value string) (string, error) {
	return h.s.decryptSettingSecret(value)
}
func (h workflowCompileHost) EncryptSetting(value string) (string, error) {
	return h.s.encryptSettingSecret(value)
}
func (h workflowCompileHost) DecryptTaskInput(raw string) (string, error) {
	return h.s.decryptTaskInputJSON(raw)
}
func (h workflowCompileHost) ProtectTaskSecrets(value any) error {
	return h.s.protectTaskSecrets(value)
}
func (h workflowCompileHost) ProviderConfig() (map[string]any, error) {
	store, err := workspace.NewProviderConfig(h.s.dataDir)
	if err != nil {
		return nil, err
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return nil, workflowBad("本地模型配置不可读，请在设置中恢复配置后再运行工作流")
	}
	return effective.Config, nil
}
func (h workflowCompileHost) LocalMode() bool { return h.s.IsLocalMode() }
func (h workflowCompileHost) ManagedCredential() (string, string, error) {
	key, base, _, _, err := h.s.lookupBeefAPICredential()
	return key, base, err
}
func (h workflowCompileHost) ManagedCredentialRef() string { return managedBeefAPIRef }
func (h workflowCompileHost) UpscaleAvailable(name string) error {
	_, err := h.s.upscaleConfig(name)
	return err
}
func (h workflowCompileHost) ValidateProviderCapability(input map[string]any) error {
	return h.s.ValidateTaskCapability(input)
}
func (h workflowCompileHost) ValidateTaskShape(input map[string]any) (string, bool, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", false, err
	}
	var taskInput canvasGenerationInput
	if err = json.Unmarshal(encoded, &taskInput); err != nil {
		return "", false, err
	}
	shape := taskInputFromCanvas(taskInput)
	shape.DeferReferenceMetadata = true
	validated, err := modelcatalog.ValidateConfiguredTask(shape, h.s.channelModelLookup())
	if err != nil {
		return "", false, err
	}
	_, ok := input["config"].(map[string]any)
	return validated.Config.VQuality, ok, nil
}
func (h workflowCompileHost) SourceTask(user, id string) (*model.Task, error) {
	return h.s.repo.TaskForUser(user, id)
}
func (h workflowCompileHost) Repository() *repository.Repository { return h.s.repo }

func (h workflowCompileHost) OutputCount(resultJSON, taskType string) int {
	return len(localtask.CanonicalOutputs(resultJSON, taskType))
}
func (h workflowCompileHost) ImageRetryBlocked(task *model.Task) bool {
	return h.s.validateImageTaskRetry(task) != nil
}
func (h workflowCompileHost) ImageCreateAccepted(user, taskID string) (bool, error) {
	receipt, err := h.s.repo.ImageCreateReceipt(user, taskID)
	if err != nil {
		return false, err
	}
	return receipt != nil && receipt.StatusCode < 300, nil
}
func (h workflowCompileHost) PersistedFailureBlocksRetry(message, stage string) bool {
	return persistedFailureBlocksRetry(message, stage)
}
