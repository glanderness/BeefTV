package playback

import (
	"sort"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
)

type memStore struct {
	mu        sync.Mutex
	resources map[string]*model.Resource
}

func (s *memStore) init() {
	if s.resources == nil {
		s.resources = map[string]*model.Resource{}
	}
}

func (s *memStore) put(resource model.Resource) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	copy := resource
	s.resources[resource.ID] = &copy
}

func (s *memStore) ResourceForUser(userID, id string) (*model.Resource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.UserID != userID {
		return nil, nil
	}
	copy := *resource
	return &copy, nil
}

func (s *memStore) ClaimPlaybackTranscode(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return false, nil
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return false, nil
	}
	resource.PlaybackStatus = model.PlaybackStatusProcessing
	resource.PlaybackError = ""
	return true, nil
}

func (s *memStore) ReleasePlaybackTranscodeClaim(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.PlaybackStatus != model.PlaybackStatusProcessing || resource.Status != model.ResourceStatusReady {
		return nil
	}
	resource.PlaybackStatus = ""
	resource.PlaybackError = ""
	return nil
}

func (s *memStore) FinishPlaybackTranscode(id, status, objectKey, errText string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.PlaybackStatus != model.PlaybackStatusProcessing || resource.Status != model.ResourceStatusReady {
		return false, nil
	}
	resource.PlaybackStatus = status
	resource.PlaybackObjectKey = objectKey
	resource.PlaybackError = errText
	return true, nil
}

func (s *memStore) MarkPlaybackNone(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return false, nil
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return false, nil
	}
	resource.PlaybackStatus = model.PlaybackStatusNone
	resource.PlaybackError = ""
	return true, nil
}

func (s *memStore) ResetStuckPlaybackTranscodes() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	for _, resource := range s.resources {
		if resource.PlaybackStatus == model.PlaybackStatusProcessing {
			resource.PlaybackStatus = ""
			resource.PlaybackError = ""
		}
	}
	return nil
}

func (s *memStore) PlaybackPendingVideos(afterCreatedAt time.Time, afterID string, limit int) ([]model.Resource, error) {
	return s.list(afterCreatedAt, afterID, limit, func(resource *model.Resource) bool {
		return resource.Kind == "video" && resource.Status == model.ResourceStatusReady && resource.Provider == "local" && resource.PlaybackStatus == ""
	})
}

func (s *memStore) PlaybackNoneVideos(afterCreatedAt time.Time, afterID string, limit int) ([]model.Resource, error) {
	return s.list(afterCreatedAt, afterID, limit, func(resource *model.Resource) bool {
		return resource.Kind == "video" && resource.Status == model.ResourceStatusReady && resource.Provider == "local" &&
			resource.PlaybackStatus == model.PlaybackStatusNone
	})
}

func (s *memStore) list(afterCreatedAt time.Time, afterID string, limit int, match func(*model.Resource) bool) ([]model.Resource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	var out []model.Resource
	for _, resource := range s.resources {
		if !match(resource) {
			continue
		}
		if resource.CreatedAt.Before(afterCreatedAt) || (resource.CreatedAt.Equal(afterCreatedAt) && resource.ID <= afterID) {
			continue
		}
		copy := *resource
		out = append(out, copy)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *memStore) get(id string) *model.Resource {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil {
		return nil
	}
	copy := *resource
	return &copy
}

func (s *memStore) setStatus(id string, status model.ResourceStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	if resource := s.resources[id]; resource != nil {
		resource.Status = status
	}
}
