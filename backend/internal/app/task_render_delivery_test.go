package app

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

// 成片走「单元级产物」路径：metadata 里没有 shotId，因此它不会写 ShotArtifact，
// 而是把渲染结果落进 delivery 阶段并完成整个工作流实例。
func TestCreateTimelineRenderTaskPersistsMetadata(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedActiveProject(t, db, "prj-render", "usr-render-test")
	seedResource(t, db, "res-1", "usr-render-test", "video/mp4")

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

// 成片是单元级产物，没有 shotId；仍要下发上下文，否则刷新后找不到在途渲染任务。
func TestTaskClientContextProjectsUnitLevelWorkflowWithoutShot(t *testing.T) {
	context := taskClientContext(`{"metadata":{"domainProjectId":"project-1","unitId":"unit-1","workflowStepId":"step-delivery","artifactType":"delivery"}}`)
	if context == nil || context.DomainProjectID != "project-1" || context.WorkflowStepID != "step-delivery" || context.ArtifactType != "delivery" {
		t.Fatalf("unit-level task context was not decoded: %+v", context)
	}
	if context.ShotID != "" {
		t.Fatalf("成片不应带镜头归属：%+v", context)
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
