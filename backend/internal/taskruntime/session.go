package taskruntime

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"infinite-canvas/backend/internal/model"
)

type session struct {
	ctx       context.Context
	task      *model.Task
	results   ResultWriter
	mu        sync.Mutex
	lost      bool
	lostErr   error
	committed bool
}

func newSession(ctx context.Context, task *model.Task, results ResultWriter) *session {
	return &session{ctx: ctx, task: task, results: results}
}

func (s *session) Context() context.Context { return s.ctx }

func (s *session) Task() *model.Task { return s.task }

func (s *session) Lost() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lost
}

func (s *session) LostErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lostErr
}

func (s *session) markLost(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lost {
		return
	}
	s.lost = true
	if err == nil {
		err = ErrLeaseLost
	} else if !errors.Is(err, ErrLeaseLost) {
		err = fmt.Errorf("%w: %s", ErrLeaseLost, err.Error())
	}
	s.lostErr = err
}

func (s *session) DidCommit() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.committed
}

func (s *session) Commit(outcome Outcome) error {
	s.mu.Lock()
	if s.lost {
		err := s.lostErr
		s.mu.Unlock()
		if err == nil {
			err = ErrLeaseLost
		}
		return err
	}
	s.committed = true
	s.mu.Unlock()
	if s.results == nil {
		return nil
	}
	return s.results.Write(s.ctx, s.task, outcome)
}
