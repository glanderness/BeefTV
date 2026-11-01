package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) taskOutcomeFacts(tasks []model.Task) map[string]localtask.OutcomeFacts {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		// 运行中和成功任务的结论不依赖派发证据。
		if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning && task.Status != model.TaskStatusSucceeded {
			ids = append(ids, task.ID)
		}
	}
	evidence, err := s.repo.ImageRecoveryEvidence(ids)
	facts := make(map[string]localtask.OutcomeFacts, len(tasks))
	for _, task := range tasks {
		f := localtask.OutcomeFacts{Unreadable: err != nil, RequestNotSent: task.Stage == taskStageRequestNotSent}
		if e, ok := evidence[task.ID]; ok {
			f.HasImageReceipt = e.HasReceipt
			if e.Attempt != nil && e.Attempt.RouteRun == task.RouteRun {
				f.DispatchState = e.Attempt.DispatchState
				if e.Submission != nil && e.Submission.UserID == task.UserID {
					f.ImageResponseAccepted = e.Submission.ResponseAccepted
					// 是否可安全重发只在实际恢复时验证，不在轮询中加载或解密快照。
				}
			}
		}
		facts[task.ID] = f
	}
	return facts
}
