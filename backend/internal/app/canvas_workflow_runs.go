package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// CanvasWorkflowRunService is the run domain service used by the HTTP layer.
func (s *Service) CanvasWorkflowRunService() *cw.Runs { return s.workflowRuns() }

func (s *Service) workflowRuns() *cw.Runs {
	return cw.NewRuns(s.repo, s.workflowTemplates(), workflowRunHost{s}, &s.canvasWorkflowMu, &s.canvasWorkflowLoop)
}

func (s *Service) startCanvasWorkflowScheduler(ctx context.Context) {
	s.workflowRuns().StartScheduler(ctx)
}

// workflowRunHost gives runs the task capabilities that stay in app.
type workflowRunHost struct{ s *Service }

func (h workflowRunHost) recipes(cipher string) (workflowRecipes, error) {
	plain, e := h.s.decryptSettingSecret(cipher)
	if e != nil {
		return nil, &cw.RecipeError{Decrypt: true, Err: e}
	}
	var recipes workflowRecipes
	if e = json.Unmarshal([]byte(plain), &recipes); e != nil {
		return nil, &cw.RecipeError{Err: e}
	}
	return recipes, nil
}

func (h workflowRunHost) ReferenceIDs(cipher string) (map[string]bool, error) {
	recipes, e := h.recipes(cipher)
	if e != nil {
		return nil, e
	}
	ids := map[string]bool{}
	for _, recipe := range recipes {
		for id := range workflowResourceIDs(recipe.Request.Input) {
			ids[id] = true
		}
	}
	return ids, nil
}

func (h workflowRunHost) Generate(user, op, cipher string, n cw.Node, nodes map[string]cw.Node, steps map[string]*cw.Step) (*model.Task, error) {
	recipes, e := h.recipes(cipher)
	if e != nil {
		return nil, e
	}
	recipe, ok := recipes[n.ID]
	if !ok {
		return nil, workflowBad("生成配方缺失")
	}
	built, e := cw.Materialize(h.s.compileHost(), user, op, recipe, nodes, steps)
	req := createTaskRequestFromRecipe(built)
	var task *model.Task
	if e == nil {
		task, e = h.s.CreateTask(user, req)
	}
	if e == nil {
		return task, nil
	}
	videos := []string{}
	seen := map[string]bool{}
	for _, binding := range recipe.Bindings {
		if binding.Field != "referenceVideos" || seen[binding.NodeID] {
			continue
		}
		seen[binding.NodeID] = true
		if value := steps[binding.NodeID]; value != nil {
			if resource, err := h.s.workflowResource(user, value.ResourceID, "video"); err == nil {
				videos = append(videos, fmt.Sprintf("%s（%.2f 秒）", nodes[binding.NodeID].Title, float64(resource.DurationMs)/1000))
			}
		}
	}
	return nil, fmt.Errorf("模型 %s；参考视频：%s；%w", recipe.Request.Model, strings.Join(videos, "、"), e)
}

func (h workflowRunHost) Describe(user, op string, n cw.Node, resource string) (*model.Task, error) {
	built, e := cw.DescribeRequest(h.s.compileHost(), n, resource, op)
	request := createTaskRequestFromRecipe(built)
	if e != nil {
		return nil, e
	}
	return h.s.CreateTask(user, request)
}

func (h workflowRunHost) Upscale(user, op string, n cw.Node, resource string) (*model.Task, error) {
	return h.s.executeWorkflowUpscale(user, op, n, resource)
}

func (h workflowRunHost) CanvasMedia(user, op string, n cw.Node, resource string) (*model.Task, error) {
	return h.s.taskDomain().CreateCanvasMediaTask(user, n, resource, op)
}

func (h workflowRunHost) DepthCapture(user, op, resource string) (*model.Task, error) {
	return h.s.CreateDepthCaptureTask(user, DepthCaptureCreateRequest{ResourceID: resource, ClientOperationID: op})
}

func (h workflowRunHost) TimelineRender(user, op string, project editing.Project, options editing.Options) (*model.Task, error) {
	return h.s.CreateTimelineRenderTask(user, TimelineRenderCreateRequest{Timeline: project, Options: options, ClientOperationID: op})
}

func (h workflowRunHost) RetryStep(row model.CanvasWorkflowRun, nodeID string, task *model.Task) (*model.Task, error) {
	if task.IsUpscale() {
		return h.s.RecoverMediaUpscale(context.Background(), row.UserID, task.ID)
	}
	input, e := cw.PrepareRetryCredentials(h.s.compileHost(), row, nodeID, task)
	if e != nil {
		return nil, e
	}
	if input != "" {
		return h.s.taskDomain().RetryWithCredentialRefresh(row.UserID, task.ID, task.InputJSON, input)
	}
	return h.s.RetryTask(row.UserID, task.ID)
}

func (h workflowRunHost) CancelTask(ctx context.Context, user, id string) error {
	_, e := h.s.CancelTask(ctx, user, id)
	return e
}

func (h workflowRunHost) Outputs(task *model.Task) ([]cw.TaskOutput, []cw.TaskOutput) {
	convert := func(values []localtask.CanonicalOutput) []cw.TaskOutput {
		out := make([]cw.TaskOutput, 0, len(values))
		for _, v := range values {
			out = append(out, cw.TaskOutput{OutputIndex: v.OutputIndex, MediaType: v.MediaType, ResourceID: v.ResourceID})
		}
		return out
	}
	stored, _ := h.s.generationDeliverer().LoadedOutputs(task.ID)
	return convert(localtask.CanonicalOutputs(task.ResultJSON, task.Type)), convert(stored)
}

func (h workflowRunHost) FailureMessage(message, stage string) string {
	return safePersistedFailureMessage(message, stage)
}

func (h workflowRunHost) Draining() bool { return h.s.IsDraining() }

func (h workflowRunHost) RunLoop(fn func(context.Context)) bool { return h.s.runWorkerLoop(fn) }
