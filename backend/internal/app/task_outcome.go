package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) taskOutcomeFacts(tasks []model.Task) map[string]localtask.OutcomeFacts {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	evidence, err := s.repo.ImageRecoveryEvidence(ids)
	facts := make(map[string]localtask.OutcomeFacts, len(tasks))
	for _, task := range tasks {
		f := localtask.OutcomeFacts{Unreadable: err != nil}
		if e, ok := evidence[task.ID]; ok {
			f.HasImageReceipt = e.HasReceipt
			if e.Attempt != nil && e.Attempt.RouteRun == task.RouteRun {
				f.DispatchState = e.Attempt.DispatchState
				if e.Submission != nil && e.Submission.UserID == task.UserID {
					f.ImageResponseAccepted = e.Submission.ResponseAccepted
					f.SafeImageReplay, _ = s.safeFrozenImageReplay(task, e.Attempt, e.Submission)
				}
			}
		}
		facts[task.ID] = f
	}
	return facts
}
