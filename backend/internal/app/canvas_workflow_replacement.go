package app

import (
	"encoding/json"
	"fmt"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"math"
	"strings"
)

func replacementNextOperation(base string, p *cw.ReplacementProgress) string {
	if p == nil || p.Plan == nil {
		return base + ":prepare"
	}
	for i, segment := range p.Plan.Segments {
		if segment.OutputResourceID == "" {
			return fmt.Sprintf("%s:part:%d", base, i)
		}
	}
	return base + ":finish"
}

// These percentages describe phase completion, never a time-based estimate.
// Keep a stable preparation/generation/finalization allocation as cuts are found.
func replacementTaskProgress(state *cw.ReplacementProgress, task *model.Task) (int, string) {
	progress := max(0, min(99, task.Progress))
	if task.Status == model.TaskStatusSucceeded {
		progress = 100
	}
	if state.Plan == nil {
		return progress / 10, "正在整理参考素材"
	}
	total := len(state.Plan.Segments)
	done := 0
	for _, part := range state.Plan.Segments {
		if part.OutputResourceID != "" {
			done++
		}
	}
	if total == 0 {
		return 10, "正在整理参考素材"
	}
	if done == total {
		return 90 + progress/10, "正在合成并校验视频"
	}
	stage := "正在生成替换视频"
	if task.Status == model.TaskStatusQueued {
		stage = "等待生成替换视频"
	} else if task.PollStage == "download" || strings.Contains(task.Stage, "取回") || strings.Contains(task.Stage, "下载") {
		stage = "正在下载生成视频"
	}
	return 10 + (done*100+progress)*80/(total*100), fmt.Sprintf("%s（%d/%d）", stage, done+1, total)
}

func (s *Service) replacementReference(user, id, kind string) (map[string]any, error) {
	r, e := s.workflowResource(user, id, kind)
	if e != nil {
		return nil, e
	}
	return map[string]any{"id": r.ID, "resourceId": r.ID, "storageKey": "resource:" + r.ID, "type": kind, "mimeType": r.MimeType, "bytes": r.Size, "width": r.Width, "height": r.Height, "durationMs": r.DurationMs}, nil
}

func (s *Service) replacementRequest(user, operation string, n cw.Node, recipe workflowRecipe, p cw.ReplacementPlan, index int, character string) (CreateTaskRequest, error) {
	var req CreateTaskRequest
	raw, e := json.Marshal(recipe.Request)
	if e != nil {
		return req, e
	}
	if e = json.Unmarshal(raw, &req); e != nil {
		return req, e
	}
	if req.Model != "seedance-2.0-fast" {
		return req, workflowBad("人物替换模型配方无效，请重新保存模板")
	}
	if e = s.refreshCanvasWorkflowCredentials(req.Input, recipe.ChannelID); e != nil {
		return req, e
	}
	video, e := s.replacementReference(user, p.Segments[index].ResourceID, "video")
	if e != nil {
		return req, e
	}
	image, e := s.replacementReference(user, character, "image")
	if e != nil {
		return req, e
	}
	prompt := "以参考视频1为唯一动作、镜头、时间顺序和场景依据，仅将其中唯一主要人物替换成参考图片1中的成年人物。保持参考图片1的同一身份、面部、发型和服装，全片一致。逐时刻保持参考视频人物的姿态、运动轨迹、肢体接触和遮挡关系，保留背景、道具、镜头运动与构图；不得重新编排动作，不得增加人物，不得出现原人物残影、肢体断裂、脸部漂移或闪烁。保持参考视频完整动作时序和画幅比例，从第一帧开始对齐；视频参考结束后保持最后画面。"
	if text, ok := n.Config["instructions"].(string); ok && text != "" {
		prompt += "\n补充要求：" + text
	}
	req.Prompt = prompt
	req.Input["prompt"] = prompt
	req.Input["referenceVideos"] = []any{video}
	req.Input["referenceImages"] = []any{image}
	req.Input["metadata"] = map[string]any{"source": "canvas-workflow", "clientOperationId": operation, "videoEditOperation": "reference_to_video"}
	config, _ := req.Input["config"].(map[string]any)
	if config == nil {
		return req, workflowBad("人物替换模型配置缺失")
	}
	config["videoSeconds"] = fmt.Sprint(p.Segments[index].GenerationSeconds)
	config["size"] = replacementRatio(p.Width, p.Height)
	config["vquality"] = "720p"
	if quality, ok := n.Config["vquality"].(string); ok {
		config["vquality"] = quality
	}
	config["generateAudio"] = false
	return req, nil
}

func replacementRatio(width, height int) string {
	best := "9:16"
	distance := math.Inf(1)
	for _, ratio := range []struct {
		name  string
		value float64
	}{{"9:16", 9.0 / 16}, {"3:4", 0.75}, {"1:1", 1}, {"4:3", 4.0 / 3}, {"16:9", 16.0 / 9}, {"21:9", 21.0 / 9}} {
		d := math.Abs(math.Log(float64(width) / float64(height) / ratio.value))
		if d < distance {
			best, distance = ratio.name, d
		}
	}
	return best
}

// Admit at most one child per checkpoint. Stable operation IDs close the crash
// window between child admission and saving the parent workflow state.
func (s *Service) advanceReplacement(row *model.CanvasWorkflowRun, n cw.Node, d cw.Definition, steps map[string]*cw.Step, step *cw.Step, recipe workflowRecipe) error {
	source, character := "", ""
	for _, edge := range d.Edges {
		if edge.To == n.ID {
			if edge.ToPort == "video" {
				source = steps[edge.From].ResourceID
			}
			if edge.ToPort == "character" {
				character = steps[edge.From].ResourceID
			}
		}
	}
	if source == "" || character == "" {
		return workflowBad("人物替换需要原视频和独立的目标人物图片")
	}
	if step.Replacement == nil {
		step.Replacement = &cw.ReplacementProgress{}
	}
	state := step.Replacement
	base := workflowOperation(row.ID, n.ID)
	operation := replacementNextOperation(base, state)
	var task *model.Task
	var err error
	if step.TaskID != "" {
		task, err = s.repo.TaskForUser(row.UserID, step.TaskID)
	} else {
		task, err = s.repo.TaskByClientOperation(row.UserID, operation)
	}
	if err != nil {
		return err
	}
	if task == nil {
		if state.Plan == nil {
			local := cw.Node{ID: n.ID, Role: "operation", MediaType: "text", OperationID: cw.ReplacementPrepareOperation, OperationVersion: 1, Config: map[string]any{"maxSegments": 12}}
			if limit, ok := n.Config["maxSegments"]; ok {
				local.Config["maxSegments"] = limit
			}
			task, err = s.taskDomain().CreateCanvasMediaTask(row.UserID, local, source, operation)
		} else {
			index := -1
			for i, segment := range state.Plan.Segments {
				if segment.OutputResourceID == "" {
					index = i
					break
				}
			}
			if index >= 0 {
				var req CreateTaskRequest
				req, err = s.replacementRequest(row.UserID, operation, n, recipe, *state.Plan, index, character)
				if err == nil {
					task, err = s.CreateTask(row.UserID, req)
				}
			} else {
				manifest, _ := json.Marshal(state.Plan)
				local := cw.Node{ID: n.ID, Role: "operation", MediaType: "video", OperationID: cw.ReplacementFinishOperation, OperationVersion: 1, Config: map[string]any{"manifest": string(manifest)}}
				task, err = s.taskDomain().CreateCanvasMediaTask(row.UserID, local, source, operation)
			}
		}
	}
	if err != nil {
		return err
	}
	if task == nil {
		return workflowBad("人物替换子任务记录缺失，已停止提交")
	}
	step.TaskID = task.ID
	step.Status = "running"
	step.Progress, step.Stage = replacementTaskProgress(state, task)
	if state.Plan == nil {
		state.PrepareTaskID = task.ID
	} else {
		found := false
		for i := range state.Plan.Segments {
			if state.Plan.Segments[i].OutputResourceID == "" {
				state.Plan.Segments[i].TaskID = task.ID
				found = true
				break
			}
		}
		if !found {
			state.FinishTaskID = task.ID
		}
	}
	switch task.Status {
	case model.TaskStatusFailed, model.TaskStatusCancelled:
		return fmt.Errorf("人物替换子任务未完成：%s", safePersistedFailureMessage(task.Error, task.Stage))
	case model.TaskStatusSucceeded:
		if state.Plan == nil {
			var result struct {
				Plan cw.ReplacementPlan `json:"replacementPlan"`
			}
			if json.Unmarshal([]byte(task.ResultJSON), &result) != nil {
				return workflowBad("人物替换准备记录损坏")
			}
			if err = cw.ValidatePreparedReplacementPlan(result.Plan, false); err != nil {
				return err
			}
			if result.Plan.SourceResourceID != source {
				return workflowBad("人物替换原视频不匹配")
			}
			for _, segment := range result.Plan.Segments {
				if err = s.protectReplacementResource(row, segment.ResourceID); err != nil {
					return err
				}
			}
			state.Plan = &result.Plan
			step.TaskID = ""
			return nil
		}
		id := workflowOutputResource(task.ResultJSON)
		if id == "" {
			return workflowBad("人物替换任务完成但结果未持久保存，请恢复任务结果")
		}
		if err = s.protectReplacementResource(row, id); err != nil {
			return err
		}
		for i := range state.Plan.Segments {
			if state.Plan.Segments[i].OutputResourceID == "" {
				state.Plan.Segments[i].OutputResourceID = id
				step.TaskID = ""
				return nil
			}
		}
		step.ResourceID = id
		step.Status = "succeeded"
		step.Progress = 100
		step.Stage = "处理完成"
		step.ReviewRequired = true
	}
	return nil
}

func (s *Service) protectReplacementResource(row *model.CanvasWorkflowRun, id string) error {
	if _, err := s.workflowResource(row.UserID, id, "video"); err != nil {
		return err
	}
	ref := model.CanvasWorkflowResource{OwnerID: row.ID, UserID: row.UserID, ResourceID: id}
	return s.repo.DB().Where("owner_id = ? AND resource_id = ?", row.ID, id).FirstOrCreate(&ref).Error
}
