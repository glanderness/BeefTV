package operations

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

type taskWaitSequence struct {
	tasks []model.Task
	reads int
}

type taskWaitDomain struct {
	unusedDomain
	mu        sync.Mutex
	sequences map[string]*taskWaitSequence
	canvas    json.RawMessage
}

func (d *taskWaitDomain) Task(_ string, id string) (*model.Task, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	sequence := d.sequences[id]
	if sequence == nil || len(sequence.tasks) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	index := sequence.reads
	if index >= len(sequence.tasks) {
		index = len(sequence.tasks) - 1
	}
	sequence.reads++
	task := sequence.tasks[index]
	return &task, nil
}

func (d *taskWaitDomain) UserCanvasProject(_ string, _ string) (json.RawMessage, error) {
	if d.canvas == nil {
		return nil, gorm.ErrRecordNotFound
	}
	return d.canvas, nil
}

func (d *taskWaitDomain) reads(id string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	if sequence := d.sequences[id]; sequence != nil {
		return sequence.reads
	}
	return 0
}

func taskWaitTask(id string, mutate func(*model.Task)) model.Task {
	task := model.Task{ID: id, Type: "canvas_image", Status: model.TaskStatusRunning}
	if mutate != nil {
		mutate(&task)
	}
	return task
}

func savedTask(id string) model.Task {
	return taskWaitTask(id, func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStateReady
		task.Outcome = &model.TaskOutcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"}
		task.Outputs = []model.TaskOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "res-1"}}
	})
}

func savingTask(id string) model.Task {
	return taskWaitTask(id, func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStatePendingMaterialization
		task.Outcome = &model.TaskOutcome{Phase: "fetching", Regenerate: "blocked", Reason: "result_fetching"}
		task.Outputs = []model.TaskOutput{{OutputIndex: 0, MediaType: "image", ProviderArtifactRef: "https://upstream.example/a.png"}}
	})
}

func runTaskWaitOp(t *testing.T, domain Domain, params string) (taskWaitResult, error) {
	t.Helper()
	value, err := opTaskWait(&Context{Context: context.Background(), Domain: domain, UserID: "user-1"}, json.RawMessage(params))
	if err != nil {
		return taskWaitResult{}, err
	}
	result, ok := value.(taskWaitResult)
	if !ok {
		t.Fatalf("结果类型 = %T", value)
	}
	return result, nil
}

func TestTaskWaitReturnsImmediatelyWhenSaved(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savedTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending || result.TimedOut || result.Failed || !result.Completed {
		t.Fatalf("已完成任务应直接返回成功: %+v", result)
	}
	if len(result.Tasks) != 1 || result.Tasks[0].TaskID != "task-1" || result.Tasks[0].State != taskWaitCompleted {
		t.Fatalf("任务视图不正确: %+v", result.Tasks)
	}
	if reads := domain.reads("task-1"); reads != 1 {
		t.Fatalf("已完成任务应只读一次，读取 %d 次", reads)
	}
}

func TestTaskWaitWaitsForCompletion(t *testing.T) {
	restore := taskWaitPollInterval
	taskWaitPollInterval = 5 * time.Millisecond
	defer func() { taskWaitPollInterval = restore }()

	running := taskWaitTask("task-1", nil)
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{running, running, savedTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1"],"timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Completed || result.Pending || result.TimedOut {
		t.Fatalf("等待中完成应返回完成: %+v", result)
	}
	if reads := domain.reads("task-1"); reads < 3 {
		t.Fatalf("应至少读取 3 次直到完成，实际 %d 次", reads)
	}
}

func TestTaskWaitTimeoutReturnsPendingAndOriginalTaskID(t *testing.T) {
	restore := taskWaitPollInterval
	taskWaitPollInterval = 5 * time.Millisecond
	defer func() { taskWaitPollInterval = restore }()

	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{taskWaitTask("task-1", nil)}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1"],"timeoutMs":30}`)
	if err != nil {
		t.Fatalf("超时不能返回错误: %v", err)
	}
	if !result.Pending || !result.TimedOut {
		t.Fatalf("超时应返回 pending/timedOut: %+v", result)
	}
	if len(result.TaskIDs) != 1 || result.TaskIDs[0] != "task-1" {
		t.Fatalf("超时应保留原 taskId: %+v", result.TaskIDs)
	}
	if len(result.Tasks) != 1 || result.Tasks[0].TaskID != "task-1" || result.Tasks[0].State != taskWaitRunning {
		t.Fatalf("超时任务视图不正确: %+v", result.Tasks)
	}
}

func TestTaskWaitTreatsSavingAsIncomplete(t *testing.T) {
	restore := taskWaitPollInterval
	taskWaitPollInterval = 2 * time.Millisecond
	defer func() { taskWaitPollInterval = restore }()

	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savingTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":15}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Pending || !result.TimedOut || result.Completed || result.Failed {
		t.Fatalf("保存中不能算完成: %+v", result)
	}
	if result.Tasks[0].State != taskWaitSaving || result.Tasks[0].Reason != "saving" {
		t.Fatalf("保存中应给出原因: %+v", result.Tasks[0])
	}
}

func TestTaskWaitReportsMaterializationFailure(t *testing.T) {
	failed := taskWaitTask("task-1", func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStateFailedPermanent
		task.Outcome = &model.TaskOutcome{Phase: "failed", Regenerate: "confirm", Reason: "result_unrecoverable"}
		task.Outputs = []model.TaskOutput{{OutputIndex: 0, MediaType: "image", MaterializationErrorCode: localtask.MaterializeErrorResourceMissing}}
	})
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{failed}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending || result.TimedOut || result.Completed || !result.Failed {
		t.Fatalf("物化失败应算失败: %+v", result)
	}
	if result.Tasks[0].State != taskWaitFailed || result.Tasks[0].Reason != "materialization_failed" {
		t.Fatalf("物化失败原因不正确: %+v", result.Tasks[0])
	}
}

func TestTaskWaitChecksNodeBinding(t *testing.T) {
	boundCanvas := func(taskID, storageKey, phase string) json.RawMessage {
		return json.RawMessage(`{"nodes":[{"id":"node-1","metadata":{"taskId":"` + taskID +
			`","status":"success","storageKey":"` + storageKey + `","taskOutcome":{"phase":"` + phase + `"}}}]}`)
	}
	cases := []struct {
		name   string
		canvas json.RawMessage
		want   bool
	}{
		{"绑定到等待的任务", boundCanvas("task-1", "resource:res-1", "ready"), true},
		{"绑定到别的任务", boundCanvas("task-2", "resource:res-1", "ready"), false},
		{"还没写资源", boundCanvas("task-1", "blob:local", "ready"), false},
		{"产物阶段未就绪", boundCanvas("task-1", "resource:res-1", "fetching"), false},
		{"节点不存在", json.RawMessage(`{"nodes":[]}`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			domain := &taskWaitDomain{
				sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{savedTask("task-1")}}},
				canvas:    tc.canvas,
			}
			result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","canvasId":"canvas-1","nodeId":"node-1","timeoutMs":2000}`)
			if err != nil {
				t.Fatal(err)
			}
			if result.Bound == nil || *result.Bound != tc.want {
				t.Fatalf("bound = %v，应为 %v", result.Bound, tc.want)
			}
		})
	}
}

func TestTaskWaitValidatesParams(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savedTask("task-1")}},
	}}
	cases := []struct {
		name   string
		params string
		reason string
	}{
		{"缺少任务", `{}`, "invalid_params"},
		{"空任务数组", `{"taskIds":[]}`, "invalid_params"},
		{"超过 8 个", `{"taskIds":["1","2","3","4","5","6","7","8","9"]}`, "invalid_batch"},
		{"负超时", `{"taskId":"task-1","timeoutMs":-1}`, "invalid_timeout"},
		{"未知字段", `{"taskId":"task-1","unknown":true}`, "unknown_field"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runTaskWaitOp(t, domain, tc.params)
			if err == nil {
				t.Fatal("应拒绝参数")
			}
			if opErr := AsError(err); opErr.Reason != tc.reason {
				t.Fatalf("reason = %s，应为 %s", opErr.Reason, tc.reason)
			}
		})
	}

	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","taskIds":["task-2"],"timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskIDs) != 1 || result.TaskIDs[0] != "task-1" {
		t.Fatalf("taskId 应优先于 taskIds: %+v", result.TaskIDs)
	}
	result, err = runTaskWaitOp(t, domain, `{"taskIds":["task-1","task-1"],"timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskIDs) != 1 {
		t.Fatalf("重复任务应去重: %+v", result.TaskIDs)
	}
}

func TestTaskWaitReturnsMissingIDsWithoutWaiting(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{}}
	started := time.Now()
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-missing"],"timeoutMs":25000}`)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("全部任务不存在时不应等满超时")
	}
	if result.Pending || result.TimedOut || len(result.Tasks) != 0 {
		t.Fatalf("不存在的任务不应伪装成待处理: %+v", result)
	}
	if len(result.MissingTaskIDs) != 1 || result.MissingTaskIDs[0] != "task-missing" {
		t.Fatalf("应列出不存在的任务: %+v", result.MissingTaskIDs)
	}
}

func TestTaskWaitResponseCarriesStableFields(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savedTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"tasks", "taskIds", "pending", "timedOut", "completed", "failed"} {
		if _, exists := payload[key]; !exists {
			t.Fatalf("响应缺少 %s: %s", key, encoded)
		}
	}
	tasks, _ := payload["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("tasks = %v", payload["tasks"])
	}
	task, _ := tasks[0].(map[string]any)
	for _, key := range []string{"taskId", "type", "status", "outputs", "resultState", "state", "reason"} {
		if _, exists := task[key]; !exists {
			t.Fatalf("任务视图缺少 %s: %v", key, task)
		}
	}
}
