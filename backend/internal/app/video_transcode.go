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

// OpenResourcePlaybackRange 打开浏览器兼容播放副本（本地 ffmpeg 转码的 H.264）。
// 仅当资源为本地存储且副本 ready 时可用；否则返回 ErrPlaybackNotReady，调用方回退原件。
func (s *Service) OpenResourcePlaybackRange(userID string, resourceID string) (*ResourceStream, error) {
	return s.playbackRuntime().OpenRange(userID, resourceID)
}

// BackfillPlaybackTranscodes uses the same runtime instance as ready callbacks.
func (s *Service) BackfillPlaybackTranscodes() {
	logPlaybackBackfill(s.playbackRuntime().Backfill(nil))
}
