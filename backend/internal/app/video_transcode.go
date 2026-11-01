package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/playback"
)

// ErrPlaybackNotReady 表示资源没有可用的浏览器兼容播放副本（未转码/转码中/失败），
// file 端点应回退 serve 原件。
var ErrPlaybackNotReady = playback.ErrNotReady

func probeGeneratedVideoMedia(data []byte) (int, int, int64) {
	return playback.ProbeGeneratedVideoMedia(data)
}

func probeVideoCodec(path string) string {
	return playback.ProbeCodec(path)
}

func firstMP4Payload(data []byte, pos, end int, want string) []byte {
	return playback.FirstPayload(data, pos, end, want)
}

func mp4Payloads(data []byte, want string) [][]byte {
	return playback.Payloads(data, want)
}

func trakHandlerType(trak []byte) string {
	return playback.TrackHandler(trak)
}

func (s *Service) maybeStartPlaybackTranscode(resource *model.Resource) {
	s.playbackRuntime().MaybeStart(resource)
}

// RecoverPlaybackTranscodes recovers interrupted claims without eagerly
// converting the library. The browser requests a copy only when needed.
func (s *Service) RecoverPlaybackTranscodes() {
	logPlaybackRecovery(s.playbackRuntime().Recover())
}

func (s *Service) PrepareResourcePlayback(userID, resourceID string) (*model.Resource, error) {
	resource, err := s.Resource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if err := s.playbackRuntime().Prepare(resource); err != nil {
		return nil, err
	}
	return s.Resource(userID, resourceID)
}
