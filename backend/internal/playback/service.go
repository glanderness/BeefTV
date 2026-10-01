package playback

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

// Service owns probe, claim, ffmpeg, persist, range, and backfill for
// local playback copies.
type Service struct {
	dataDir   string
	store     Store
	runner    Runner
	lookPath  func(file string) (string, error)
	transcode func(src string, dst string) error
}

func New(deps Deps) *Service {
	lookPath := deps.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	transcode := deps.Transcode
	if transcode == nil {
		transcode = runH264Transcode
	}
	return &Service{
		dataDir:   deps.DataDir,
		store:     deps.Store,
		runner:    deps.Runner,
		lookPath:  lookPath,
		transcode: transcode,
	}
}

// MaybeStart is called from the resource-ready seam. H.265 / MPEG-4 Part 2
// claim processing and transcode asynchronously when ffmpeg is available.
// H.264 / AV1 / VP9 / unreadable containers mark none so the UI does not
// poll forever.
func (s *Service) MaybeStart(resource *model.Resource) {
	if s == nil || resource == nil || resource.Kind != "video" {
		return
	}
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		if resource.Provider != "local" {
			markNone(s.store, resource)
		}
		return
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return
	}
	if _, err := s.lookPath("ffmpeg"); err != nil {
		markNone(s.store, resource)
		return
	}
	src, err := s.sourcePath(resource.ObjectKey)
	if err != nil {
		markNone(s.store, resource)
		return
	}
	switch ProbeCodec(src) {
	case CodecH265, CodecMPEG4:
		if s.store == nil {
			return
		}
		claimed, err := s.store.ClaimPlaybackTranscode(resource.ID)
		if err != nil || !claimed {
			return
		}
		resource.PlaybackStatus = model.PlaybackStatusProcessing
		s.launch(resource.UserID, resource.ID, src)
	case CodecH264, CodecAV1, CodecVP9, "":
		markNone(s.store, resource)
	}
}

func (s *Service) launch(userID, resourceID, src string) {
	run := func() { s.runTranscode(userID, resourceID, src) }
	if s.runner != nil && s.runner.Go(run) {
		return
	}
	// Tests and a drain window may have no live worker slot. Keep the
	// existing fire-and-forget transcode rather than dropping the claim.
	go run()
}

func (s *Service) runTranscode(userID string, resourceID string, src string) {
	defer func() {
		if r := recover(); r != nil {
			if s.store == nil {
				return
			}
			if res, err := s.store.ResourceForUser(userID, resourceID); err == nil && res != nil {
				res.PlaybackStatus = model.PlaybackStatusFailed
				res.PlaybackError = clipText(fmt.Sprintf("转码 panic：%v", r), 1000)
				_ = persistResource(s.store, res, "panic")
			}
		}
	}()
	status := model.PlaybackStatusFailed
	objectKey := ""
	var errText string
	key, err := copyObjectKey(resourceID)
	if err != nil {
		errText = clipText(err.Error(), 1000)
		s.persistOutcome(userID, resourceID, status, objectKey, errText)
		return
	}
	dst, err := s.copyPath(key)
	if err != nil {
		errText = clipText(err.Error(), 1000)
		s.persistOutcome(userID, resourceID, status, objectKey, errText)
		return
	}
	if ProbeCodec(dst) == CodecH264 {
		status = model.PlaybackStatusReady
		objectKey = key
	} else if err := s.transcode(src, dst); err != nil {
		errText = clipText(err.Error(), 1000)
	} else {
		status = model.PlaybackStatusReady
		objectKey = key
	}
	s.persistOutcome(userID, resourceID, status, objectKey, errText)
}

func (s *Service) persistOutcome(userID, resourceID, status, objectKey, errText string) {
	if s.store == nil {
		return
	}
	res, err := s.store.ResourceForUser(userID, resourceID)
	if err != nil || res == nil {
		log.Printf("playback transcode persist skipped: resource=%s user=%s lookup_error=%v", resourceID, userID, err)
		return
	}
	res.PlaybackStatus = status
	res.PlaybackObjectKey = objectKey
	res.PlaybackError = errText
	_ = persistResource(s.store, res, "transcode_complete")
}

// OpenRange opens the browser-compatible H.264 copy. Only a local ready
// copy is served; otherwise ErrNotReady so the caller can fall back.
func (s *Service) OpenRange(userID string, resourceID string) (*assets.ResourceStream, error) {
	if s == nil || s.store == nil {
		return nil, ErrNotReady
	}
	resource, err := s.store.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource == nil || resource.Status != model.ResourceStatusReady || resource.Provider != "local" ||
		resource.PlaybackStatus != model.PlaybackStatusReady || resource.PlaybackObjectKey == "" {
		return nil, ErrNotReady
	}
	path, err := s.copyPath(resource.PlaybackObjectKey)
	if err != nil {
		return nil, err
	}
	if err := ensureSafeExistingPath(s.playbackRoot(), path); err != nil {
		return nil, err
	}
	body, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	playback := *resource
	playback.MimeType = "video/mp4"
	playback.ObjectKey = filepath.Join(DirName, resource.PlaybackObjectKey)
	size := int64(0)
	if st, err := body.Stat(); err == nil {
		size = st.Size()
	}
	return &assets.ResourceStream{
		Resource:      &playback,
		Body:          body,
		StatusCode:    http.StatusOK,
		ContentLength: size,
		AcceptRanges:  "bytes",
	}, nil
}

// Backfill scans local ready videos after process start: empty status is
// judged, H.265/MPEG-4 claimed, H.264 marked none. Processing leftovers
// from a crash are reset first. A bounded none-row pass covers codec
// rule changes that previously marked H.265 as playable.
func (s *Service) Backfill() {
	if s == nil || s.store == nil {
		return
	}
	_ = s.store.ResetStuckPlaybackTranscodes()
	for {
		resources, err := s.store.PlaybackPendingVideos(backfillBatch)
		if err != nil || len(resources) == 0 {
			break
		}
		for i := range resources {
			s.MaybeStart(&resources[i])
		}
	}
	legacy, err := s.store.PlaybackNoneVideos(backfillBatch)
	if err == nil {
		for i := range legacy {
			s.MaybeStart(&legacy[i])
		}
	}
}
