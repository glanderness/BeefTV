package playback

import (
	"sync"

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

func (s *memStore) ResourceForUser(userID string, id string) (*model.Resource, error) {
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

func (s *memStore) SaveResource(resource *model.Resource) error {
	if resource == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	copy := *resource
	s.resources[resource.ID] = &copy
	return nil
}

func (s *memStore) ClaimPlaybackTranscode(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil {
		return false, nil
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return false, nil
	}
	resource.PlaybackStatus = model.PlaybackStatusProcessing
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

func (s *memStore) PlaybackPendingVideos(limit int) ([]model.Resource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	var out []model.Resource
	for _, resource := range s.resources {
		if resource.Kind == "video" && resource.Status == model.ResourceStatusReady && resource.Provider == "local" && resource.PlaybackStatus == "" {
			copy := *resource
			out = append(out, copy)
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *memStore) PlaybackNoneVideos(limit int) ([]model.Resource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	var out []model.Resource
	for _, resource := range s.resources {
		if resource.Kind == "video" && resource.Status == model.ResourceStatusReady && resource.Provider == "local" &&
			resource.PlaybackStatus == model.PlaybackStatusNone {
			copy := *resource
			out = append(out, copy)
		}
	}
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
