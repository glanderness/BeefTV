package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

// 成片走「单元级产物」路径：metadata 里没有 shotId，因此它不会写 ShotArtifact，
// 而是把渲染结果落进 delivery 阶段并完成整个工作流实例。
func TestCreateTimelineRenderTaskPersistsMetadata(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)

	task, err := svc.CreateTimelineRenderTask("usr-render-test", TimelineRenderCreateRequest{
		ProjectID: "prj-render",
		Timeline:  renderTestProject("resource:res-1"),
		Metadata: map[string]any{
			"workflowStepId":  "step-delivery-1",
			"domainProjectId": "prj-render",
			"unitId":          "unit-1",
			"artifactType":    "delivery",
			"role":            "output",
			"mediaType":       "video",
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	// metadata 必须随任务持久化，否则任务成功时无法把产物登记回工作流阶段。
	for key, want := range map[string]string{
		"workflowStepId":  "step-delivery-1",
		"domainProjectId": "prj-render",
		"unitId":          "unit-1",
		"artifactType":    "delivery",
		"mediaType":       "video",
	} {
		if got, _ := input.Metadata[key].(string); got != want {
			t.Fatalf("metadata[%s] = %q, want %q", key, got, want)
		}
	}
	// 成片是单元级产物，不能携带镜头归属。
	if _, exists := input.Metadata["shotId"]; exists {
		t.Fatal("成片 metadata 不应包含 shotId")
	}
	if len(input.Timeline.Clips) != 1 {
		t.Fatalf("clips = %d, want 1", len(input.Timeline.Clips))
	}
}

func TestRegisterTaskOutputFromTaskCompletesDeliveryStep(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	project, unit := seedWorkflowProject(t, db)
	if err := service.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := service.CreateUnitWorkflow("user-1", project.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	var deliveryStep model.WorkflowStepInstance
	for _, step := range workflow.Steps {
		if step.StepKey == "delivery" {
			deliveryStep = step
		}
	}
	if deliveryStep.ID == "" {
		t.Fatal("未找到 delivery 阶段")
	}

	now := time.Now()
	// 渲染结果结构对齐 timelineRenderResult。
	resultJSON := `{"resourceId":"resource-render-1","fileName":"episode.mp4","size":2048,"durationMs":6000,"subtitleSrt":"1\n00:00:00,000 --> 00:00:06,000\n你好\n"}`
	task := model.Task{
		ID: "ac745990450a86d3365eb92ec26f3780", UserID: "user-1", ProjectID: project.ID,
		Type: model.TaskTypeTimelineRender, Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"workflowStepId":"` + deliveryStep.ID + `","domainProjectId":"` + project.ID + `","unitId":"` + unit.ID + `","artifactType":"delivery","role":"output","mediaType":"video"}}`,
		ResultJSON: resultJSON, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := service.RegisterTaskOutputFromTask(task); err != nil {
		t.Fatal(err)
	}

	var stored model.WorkflowStepInstance
	if err := db.First(&stored, "id = ?", deliveryStep.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.WorkflowStepStatusCompleted {
		t.Fatalf("delivery 状态 = %q, want completed", stored.Status)
	}
	// 成片资源由前端从 OutputJSON 读取（TaskSummary 不下发 resultJson）。
	if stored.OutputJSON != resultJSON {
		t.Fatalf("outputJson = %q, want 渲染结果", stored.OutputJSON)
	}

	// 单元级产物不能写镜头产物表——ShotArtifact 是镜头级唯一索引。
	var artifactCount int64
	if err := db.Model(&model.ShotArtifact{}).Where("task_id = ?", task.ID).Count(&artifactCount).Error; err != nil {
		t.Fatal(err)
	}
	if artifactCount != 0 {
		t.Fatalf("shot_artifacts = %d, want 0", artifactCount)
	}

	var link model.ProductionTaskLink
	if err := db.First(&link, "task_id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if link.ArtifactType != "delivery" || link.ShotID != "" || link.UnitID != unit.ID {
		t.Fatalf("production link = %+v, want delivery/空镜头/unit-1", link)
	}

	// delivery 是末段，登记后整个实例应完成。
	var instance model.WorkflowInstance
	if err := db.First(&instance, "id = ?", deliveryStep.WorkflowInstanceID).Error; err != nil {
		t.Fatal(err)
	}
	if instance.Status != model.WorkflowStatusCompleted {
		t.Fatalf("instance 状态 = %q, want completed", instance.Status)
	}
}

// 缺少 workflowStepId 时不能登记产物：否则任意成功任务都会污染工作流阶段。
func TestRegisterTaskOutputFromTaskWithoutWorkflowStepIsNoop(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	project, unit := seedWorkflowProject(t, db)
	if err := service.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateUnitWorkflow("user-1", project.ID, unit.ID); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	task := model.Task{
		ID: "ac745990450a86d3365eb92ec26f3781", UserID: "user-1", ProjectID: project.ID,
		Type: model.TaskTypeTimelineRender, Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"domainProjectId":"` + project.ID + `","unitId":"` + unit.ID + `"}}`,
		ResultJSON: `{"resourceId":"resource-render-2"}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := service.RegisterTaskOutputFromTask(task); err != nil {
		t.Fatalf("register: want nil, got %v", err)
	}

	var completed int64
	if err := db.Model(&model.WorkflowStepInstance{}).
		Where("workflow_instance_id IN (SELECT id FROM workflow_instances WHERE project_id = ?) AND status = ?", project.ID, model.WorkflowStepStatusCompleted).
		Count(&completed).Error; err != nil {
		t.Fatal(err)
	}
	if completed != 0 {
		t.Fatalf("已完成阶段数 = %d, want 0（无 workflowStepId 时不应登记）", completed)
	}
}

// 渲染任务由独立执行器自行写终态，不经过 taskTerminalCoordinator；
// 若执行器忘了登记产物，成片结果就永远回不到交付阶段。这个回归测试盯住那条调用。
//
// 渲染步骤本身由真实 ffmpeg + 真实资源覆盖（见交付验证脚本），这里用 shim 替换 ffmpeg
// 二进制，只为在无 ffmpeg 环境下也能验证「成功后必须登记」这条接线。
func TestProcessTimelineRenderRegistersDeliveryOutput(t *testing.T) {
	service, db := newTimelineTaskTestService(t)
	service.mode = serviceModeLocal
	service.dataDir = t.TempDir()
	service.localResourceStorage = true

	project, unit := seedWorkflowProject(t, db)
	if err := service.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
		t.Fatal(err)
	}
	workflow, err := service.CreateUnitWorkflow("user-1", project.ID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	var deliveryStep model.WorkflowStepInstance
	for _, step := range workflow.Steps {
		if step.StepKey == "delivery" {
			deliveryStep = step
		}
	}
	if deliveryStep.ID == "" {
		t.Fatal("未找到 delivery 阶段")
	}

	resource, _, err := service.storeResource("user-1", "media", "shot.mp4", "video/mp4", 1024, renderWidth, renderHeight, 2000,
		bytes.NewReader([]byte("source-bytes")), nil, true)
	if err != nil || resource == nil {
		t.Fatalf("store resource: %v", err)
	}

	ffmpegShim := filepath.Join(t.TempDir(), "fake-ffmpeg")
	// cmd.Dir 是渲染工作目录，因此直接按文件名写产物即可。
	if err := os.WriteFile(ffmpegShim, []byte("#!/bin/sh\nprintf 'beeftv-rendered' > render-output.mp4\n"), 0o755); err != nil {
		t.Fatalf("write ffmpeg shim: %v", err)
	}
	t.Setenv(renderFfmpegEnv, ffmpegShim)

	inputJSON, err := json.Marshal(timelineRenderInput{
		ProjectID: project.ID,
		Timeline:  renderTestProject("resource:" + resource.ID),
		Metadata: map[string]any{
			"workflowStepId":  deliveryStep.ID,
			"domainProjectId": project.ID,
			"unitId":          unit.ID,
			"artifactType":    "delivery",
			"role":            "output",
			"mediaType":       "video",
		},
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	task := seedRunningRenderTask(t, db, string(inputJSON))
	task.ProjectID = project.ID
	task.UserID = "user-1"
	if err := db.Save(task).Error; err != nil {
		t.Fatal(err)
	}

	if err := newTaskWorkerCoordinator(service).processTimelineRender(task, context.Background()); err != nil {
		t.Fatalf("process: want nil (任务自行写终态), got %v", err)
	}

	var storedTask model.Task
	if err := db.First(&storedTask, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedTask.Status != model.TaskStatusSucceeded {
		t.Fatalf("任务状态 = %q, want succeeded（error=%s）", storedTask.Status, storedTask.Error)
	}

	// 核心断言：渲染成功后必须把产物登记回交付阶段。
	var stored model.WorkflowStepInstance
	if err := db.First(&stored, "id = ?", deliveryStep.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.WorkflowStepStatusCompleted {
		t.Fatalf("delivery 状态 = %q, want completed（渲染成功后未登记产物）", stored.Status)
	}
	if stored.OutputJSON != storedTask.ResultJSON {
		t.Fatalf("outputJson = %q, want 渲染结果 %q", stored.OutputJSON, storedTask.ResultJSON)
	}
	var link model.ProductionTaskLink
	if err := db.First(&link, "task_id = ?", task.ID).Error; err != nil {
		t.Fatalf("缺少产物溯源链: %v", err)
	}
	if link.ArtifactType != "delivery" || link.ShotID != "" {
		t.Fatalf("溯源链 = %+v, want delivery/空镜头", link)
	}
}
