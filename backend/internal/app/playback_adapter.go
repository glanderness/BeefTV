package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/playback"
	"infinite-canvas/backend/internal/repository"
)

// playbackRuntime is a lazy constructor until Lead wires playback.Service
// on the composition root. Do not add a Service field here.
func (s *Service) playbackRuntime() *playback.Service {
	if s == nil {
		return playback.New(playback.Deps{})
	}
	return playback.New(playback.Deps{
		DataDir: s.dataDir,
		Store:   playbackStore{repo: s.repo},
		Runner:  playbackRunner{svc: s},
	})
}

type playbackStore struct {
	repo *repository.Repository
}

func (s playbackStore) ResourceForUser(userID string, id string) (*model.Resource, error) {
	if s.repo == nil {
		return nil, nil
	}
	return s.repo.ResourceForUser(userID, id)
}

func (s playbackStore) SaveResource(resource *model.Resource) error {
	if s.repo == nil {
		return nil
	}
	return s.repo.SaveResource(resource)
}

func (s playbackStore) ClaimPlaybackTranscode(id string) (bool, error) {
	if s.repo == nil {
		return false, nil
	}
	return s.repo.ClaimPlaybackTranscode(id)
}

func (s playbackStore) ResetStuckPlaybackTranscodes() error {
	if s.repo == nil {
		return nil
	}
	return s.repo.ResetStuckPlaybackTranscodes()
}

func (s playbackStore) PlaybackPendingVideos(limit int) ([]model.Resource, error) {
	if s.repo == nil {
		return nil, nil
	}
	return s.repo.PlaybackPendingVideos(limit)
}

func (s playbackStore) PlaybackNoneVideos(limit int) ([]model.Resource, error) {
	if s.repo == nil {
		return nil, nil
	}
	return s.repo.PlaybackNoneVideos(limit)
}

type playbackRunner struct {
	svc *Service
}

func (r playbackRunner) Go(fn func()) bool {
	if r.svc == nil || fn == nil {
		return false
	}
	if r.svc.runWorkerTask(fn) {
		return true
	}
	r.svc.backgroundWorkers().Start()
	return r.svc.runWorkerTask(fn)
}
