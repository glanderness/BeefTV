package taskbinding

import (
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

type fakePorts struct {
	task      *model.Task
	taskErr   error
	outputs   []localtask.CanonicalOutput
	outputErr error
	resource  *model.Resource
	resources map[string]*model.Resource
	resErr    error
	asset     *model.Asset
	assetErr  error
	bind      func(NodePatch) (NodeBindResult, error)
	binds     int
	lastPatch NodePatch
}

func (f *fakePorts) Task(string, string) (*model.Task, error) { return f.task, f.taskErr }
func (f *fakePorts) GenerationOutputs(string) ([]localtask.CanonicalOutput, error) {
	return f.outputs, f.outputErr
}
func (f *fakePorts) OwnedReadyResource(_ string, id string) (*model.Resource, error) {
	if f.resources != nil {
		return f.resources[id], f.resErr
	}
	return f.resource, f.resErr
}

func TestWorkflowCollectionValidatesEveryResourceOwner(t *testing.T) {
	ports := &fakePorts{resources: map[string]*model.Resource{
		"primary":   {ID: "primary", UserID: "user-1", Status: model.ResourceStatusReady},
		"secondary": {ID: "secondary", UserID: "other-user", Status: model.ResourceStatusReady},
	}}
	raw := `{"outputs":[{"sourceNodeId":"9"},{"sourceNodeId":"10"}]}`
	outputs := []localtask.CanonicalOutput{{OutputIndex: 0, MediaType: "video", ResourceID: "primary"}, {OutputIndex: 1, MediaType: "file", ResourceID: "secondary"}}
	if _, err := workflowOutputReferences(ports, "user-1", raw, outputs); err == nil {
		t.Fatal("foreign secondary output was accepted")
	}
	ports.resources["secondary"].UserID = "user-1"
	refs, err := workflowOutputReferences(ports, "user-1", raw, outputs)
	if err != nil || len(refs) != 2 {
		t.Fatalf("refs=%#v err=%v", refs, err)
	}
	if refs[1].(map[string]any)["storageKey"] != "resource:secondary" || refs[1].(map[string]any)["sourceNodeId"] != "10" {
		t.Fatal("lost authoritative resource or origin")
	}
}

func TestWorkflowWithoutRequestedMediaBindsOnlyItsResultCollection(t *testing.T) {
	task := testImageTask()
	task.Type = "canvas_video"
	task.ResultJSON = `{"outputs":[{"mediaType":"file"}]}`
	ports := &fakePorts{resource: &model.Resource{ID: "file", UserID: "user-1", Status: model.ResourceStatusReady}, outputs: []localtask.CanonicalOutput{{OutputIndex: 0, MediaType: "file", ResourceID: "file"}}}
	patch, err := durablePatch(ports, "user-1", *task, Request{CanvasID: "canvas-1", NodeID: "node-1", TaskID: task.ID, OutputIndex: 0})
	if err != nil || !patch.CollectionOnly || len(patch.GenerationOutputs) != 1 || patch.Content != "" {
		t.Fatalf("patch=%#v err=%v", patch, err)
	}
}
func (f *fakePorts) OwnedAsset(string, string) (*model.Asset, error) { return f.asset, f.assetErr }
func (f *fakePorts) BindExistingNode(_ string, patch NodePatch) (NodeBindResult, error) {
	f.binds++
	f.lastPatch = patch
	if f.bind != nil {
		return f.bind(patch)
	}
	return NodeBindResult{Revision: 4, Node: map[string]any{"id": patch.NodeID, "title": "手工标题"}}, nil
}

func testImageTask() *model.Task {
	return &model.Task{
		ID: "task-1", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_image",
		Status:    model.TaskStatusSucceeded,
		InputJSON: `{"metadata":{"source":"canvas","nodeId":"node-1"}}`,
	}
}

func testAsset(id, userID, resourceID string) *model.Asset {
	return &model.Asset{
		ID: id, UserID: userID,
		PayloadJSON: `{"id":"` + id + `","data":{"storageKey":"resource:` + resourceID + `"}}`,
	}
}

func TestBindMediaUsesDurableOutputNotClientURL(t *testing.T) {
	ports := &fakePorts{
		task: testImageTask(),
		outputs: []localtask.CanonicalOutput{{
			OutputIndex: 0, MediaType: "image", MaterializedAssetID: "generation_abc", ResourceID: "res-1",
		}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady, Kind: "image", MimeType: "image/png", Size: 12, Width: 8, Height: 8},
		asset:    testAsset("generation_abc", "user-1", "res-1"),
	}
	receipt, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !receipt.Applied || receipt.AssetID != "generation_abc" || receipt.ResourceID != "res-1" || receipt.StorageKey != "resource:res-1" {
		t.Fatalf("receipt = %#v", receipt)
	}
	if ports.lastPatch.Content != "/api/resources/res-1/file" {
		t.Fatalf("content = %q", ports.lastPatch.Content)
	}
	if ports.lastPatch.EffectKey != localtask.AttachNodeEffectKey("task-1", "node-1", 0) {
		t.Fatalf("effect = %q", ports.lastPatch.EffectKey)
	}
}

func TestBindTextUsesDurableResultJSON(t *testing.T) {
	ports := &fakePorts{
		task: &model.Task{
			ID: "task-text", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_text",
			Status:     model.TaskStatusSucceeded,
			InputJSON:  `{"metadata":{"nodeId":"node-text"}}`,
			ResultJSON: `{"text":"成片旁白","rows":[{"shotNumber":1,"action":"开门"}]}`,
		},
	}
	receipt, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-text", NodeID: "node-text"})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Content != "成片旁白" || ports.lastPatch.Storyboard == nil {
		t.Fatalf("text receipt = %#v patch=%#v", receipt, ports.lastPatch)
	}
	if ports.binds != 1 {
		t.Fatalf("text bind must go through the same receipt write, got %d", ports.binds)
	}
}

func TestBindRejectsUnreadableAndNotReadyOutputs(t *testing.T) {
	unreadable := &fakePorts{
		task:      testImageTask(),
		outputErr: precondition("delivery_unreadable", "任务产物无法读取"),
	}
	if _, err := Bind(unreadable, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "delivery_unreadable") {
		t.Fatalf("unreadable = %v", err)
	}
	missing := &fakePorts{task: testImageTask()}
	if _, err := Bind(missing, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "output_not_ready") {
		t.Fatalf("missing output = %v", err)
	}
	pending := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", Status: model.ResourceStatusPending},
	}
	if _, err := Bind(pending, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "resource_not_ready") {
		t.Fatalf("pending resource = %v", err)
	}
}

func TestBindRejectsForeignAssetAndWrongNode(t *testing.T) {
	foreign := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "other", "res-1"),
	}
	if _, err := Bind(foreign, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "asset_foreign") {
		t.Fatalf("foreign asset = %v", err)
	}
	mismatch := &fakePorts{task: testImageTask()}
	if _, err := Bind(mismatch, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "other-node"}); !isBindReason(err, "node_mismatch") {
		t.Fatalf("wrong node = %v", err)
	}
}

func TestBindRetriesRevisionConflictThenStops(t *testing.T) {
	ports := &fakePorts{
		task: testImageTask(),
		outputs: []localtask.CanonicalOutput{{
			OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1",
		}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "user-1", "res-1"),
	}
	ports.bind = func(NodePatch) (NodeBindResult, error) {
		return NodeBindResult{}, conflict("stale_revision", "云端画布已有更新")
	}
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "stale_revision") {
		t.Fatalf("stale = %v", err)
	}
	if ports.binds != maxBindRevisionAttempts {
		t.Fatalf("retries = %d", ports.binds)
	}
}

func TestBindTextRejectsNonZeroOutputIndex(t *testing.T) {
	ports := &fakePorts{
		task: &model.Task{
			ID: "task-text", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_text",
			Status:     model.TaskStatusSucceeded,
			InputJSON:  `{"metadata":{"nodeId":"node-text"}}`,
			ResultJSON: `{"text":"成片旁白"}`,
		},
	}
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-text", NodeID: "node-text", OutputIndex: 1}); !isBindReason(err, "invalid_params") {
		t.Fatalf("text index 1 = %v", err)
	}
	if ports.binds != 0 {
		t.Fatalf("text index 1 still bound, binds=%d", ports.binds)
	}
}

func TestBindRejectsPortReturnedForeignResourceAndMismatchedAsset(t *testing.T) {
	foreignResource := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", UserID: "other", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "user-1", "res-1"),
	}
	if _, err := Bind(foreignResource, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "resource_foreign") {
		t.Fatalf("foreign resource = %v", err)
	}
	mismatched := &fakePorts{
		task:     testImageTask(),
		outputs:  []localtask.CanonicalOutput{{OutputIndex: 0, MaterializedAssetID: "generation_abc", ResourceID: "res-1"}},
		resource: &model.Resource{ID: "res-1", UserID: "user-1", Status: model.ResourceStatusReady},
		asset:    testAsset("generation_abc", "user-1", "res-other"),
	}
	if _, err := Bind(mismatched, "user-1", Request{CanvasID: "canvas-1", TaskID: "task-1", NodeID: "node-1"}); !isBindReason(err, "resource_mismatch") {
		t.Fatalf("mismatched asset resource = %v", err)
	}
}

func isBindReason(err error, reason string) bool {
	var bindErr *Error
	return errors.As(err, &bindErr) && bindErr.Reason == reason && strings.TrimSpace(bindErr.Message) != ""
}
