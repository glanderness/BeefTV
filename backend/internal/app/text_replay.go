package app

import (
	"context"
	"log"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/textreplay"
)

type TextReplayResult = textreplay.Result

var textReplayOwners sync.Map

func isTextReplayTaskRequest(input map[string]any) bool {
	return textreplay.IsRequest(input)
}

func (s *Service) textReplayOrInit() *textreplay.Service {
	if s == nil {
		return nil
	}
	if existing, ok := textReplayOwners.Load(s); ok {
		return existing.(*textreplay.Service)
	}
	created := textreplay.New(textreplay.NewStore(s.repo), textreplay.Dependencies{
		Logger: taskLogAdapter{s},
	})
	actual, _ := textReplayOwners.LoadOrStore(s, created)
	return actual.(*textreplay.Service)
}

// TextReplayLogger is the composition-root log port. Lead can pass it into
// textreplay.New without importing unexported app adapters.
func (s *Service) TextReplayLogger() textreplay.Logger {
	if s == nil {
		return nil
	}
	return taskLogAdapter{s}
}

// TextReplay is the lazy domain handle until Lead stores a long-lived
// *textreplay.Service on the composition root and Service.
func (s *Service) TextReplay() *textreplay.Service {
	return s.textReplayOrInit()
}

func (s *Service) CompleteTextReplayTask(userID string, taskID string, text string) (*model.Task, error) {
	return s.textReplayOrInit().Complete(userID, taskID, text)
}

func (s *Service) AppendTaskTextDelta(userID string, taskID string, content string) (*model.TaskTextDelta, error) {
	return s.textReplayOrInit().Append(userID, taskID, content)
}

func (s *Service) TaskTextReplay(userID string, taskID string, after int64) (*TextReplayResult, error) {
	return s.textReplayOrInit().Read(userID, taskID, after)
}

func (s *Service) finalizeTaskTextReplay(taskID string, status model.TaskStatus) error {
	return s.textReplayOrInit().Finalize(taskID, status)
}

func (s *Service) CleanupTaskTextReplay() (int64, error) {
	return s.textReplayOrInit().Sweep()
}

func (s *Service) AdminTextReplayStats(actor *model.User) (textreplay.Stats, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return textreplay.Stats{}, err
	}
	return s.textReplayOrInit().Stats()
}

func (s *Service) startTextReplayCleanup(ctx context.Context) {
	replay := s.textReplayOrInit()
	s.runWorkerLoop(func(ctx context.Context) {
		replay.RunCleanupLoop(ctx, time.Hour, func(err error) {
			log.Printf("text replay cleanup failed: %v", err)
		})
	})
}
