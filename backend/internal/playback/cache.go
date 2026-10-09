package playback

import (
	"fmt"
	"infinite-canvas/backend/internal/model"
	"os"
)

// CacheStore only lists completed copies belonging to the authenticated user.
// In-flight work is left alone; original resource objects are never removed.
type CacheStore interface {
	PlaybackCopiesForUser(userID string) ([]model.Resource, error)
	ResetPlaybackCopy(userID, id, objectKey string) error
}

func (s *Service) ClearCache(userID string) (int, error) {
	store, ok := s.store.(CacheStore)
	if !ok {
		return 0, fmt.Errorf("视频预览缓存暂时无法清理")
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	rows, err := store.PlaybackCopiesForUser(userID)
	if err != nil {
		return 0, err
	}
	cleared := 0
	for _, row := range rows {
		if row.PlaybackObjectKey != "" {
			path, err := s.copyPath(row.PlaybackObjectKey)
			if err != nil {
				return cleared, err
			}
			if err := ensureSafeExistingPath(s.playbackRoot(), path); err != nil && !os.IsNotExist(err) {
				return cleared, err
			}
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return cleared, err
			}
		}
		if err := store.ResetPlaybackCopy(userID, row.ID, row.PlaybackObjectKey); err != nil {
			return cleared, err
		}
		cleared++
	}
	return cleared, nil
}
