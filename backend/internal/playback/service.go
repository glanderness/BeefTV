package playback

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

// Service owns probe, claim, ffmpeg, persist, range, and backfill for
// local playback copies.
type Service struct {
	dataDir        string
	store          Store
	runner         Runner
	ctx            context.Context
	runtimeContext func() context.Context
	recoveryOnce   sync.Once
	recoveryErr    error
	lookPath       func(file string) (string, error)
	transcode      func(ctx context.Context, src string, dst string) error
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
	ctx := deps.Context
	if ctx == nil {
		ctx = context.Background()
	}
	return &Service{
		dataDir:        deps.DataDir,
		store:          deps.Store,
		runner:         deps.Runner,
		ctx:            ctx,
		runtimeContext: deps.RuntimeContext,
		lookPath:       lookPath,
		transcode:      transcode,
	}
}

func (s *Service) runContext(ctx context.Context) context.Context {
	if ctx != nil {
		return ctx
	}
	if s != nil && s.runtimeContext != nil {
		if owned := s.runtimeContext(); owned != nil {
			return owned
		}
		stopped, cancel := context.WithCancel(context.Background())
		cancel()
		return stopped
	}
	if s != nil && s.ctx != nil {
		return s.ctx
	}
	return context.Background()
}

// MaybeStart is called from the resource-ready seam. H.265 / MPEG-4 Part 2
// claim processing and transcode asynchronously when ffmpeg is available.
// H.264 / AV1 / VP9 / unreadable containers mark none so the UI does not
// poll forever. Stop/cancel refuses new claims.
func (s *Service) MaybeStart(resource *model.Resource) {
	if s == nil || resource == nil || resource.Kind != "video" {
		return
	}
	if s.runContext(nil).Err() != nil {
		return
	}
	if s.Recover() != nil {
		return
	}
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		if resource.Provider != "local" {
			markNone(s.store, resource.ID, resource.PlaybackStatus)
		}
		return
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return
	}
	if _, err := s.lookPath("ffmpeg"); err != nil {
		markNone(s.store, resource.ID, resource.PlaybackStatus)
		return
	}
	src, err := s.sourcePath(resource.ObjectKey)
	if err != nil {
		markNone(s.store, resource.ID, resource.PlaybackStatus)
		return
	}
	switch ProbeCodec(src) {
	case CodecH265, CodecMPEG4:
		if s.store == nil || s.runner == nil {
			return
		}
		claimed, err := s.store.ClaimPlaybackTranscode(resource.ID)
		if err != nil || !claimed {
			return
		}
		resource.PlaybackStatus = model.PlaybackStatusProcessing
		s.launch(resource.ID, src)
	case CodecH264, CodecAV1, CodecVP9, "":
		markNone(s.store, resource.ID, resource.PlaybackStatus)
	}
}

func (s *Service) launch(resourceID, src string) {
	if s.runner == nil || s.runContext(nil).Err() != nil {
		releaseClaim(s.store, resourceID)
		return
	}
	accepted := s.runner.Go(func(ctx context.Context) {
		s.runTranscode(ctx, resourceID, src)
	})
	if !accepted {
		releaseClaim(s.store, resourceID)
	}
}

func (s *Service) runTranscode(ctx context.Context, resourceID string, src string) {
	ctx = s.runContext(ctx)
	defer func() {
		if r := recover(); r != nil {
			if ctx.Err() != nil {
				releaseClaim(s.store, resourceID)
				return
			}
			_, _ = finishPlayback(s.store, resourceID, model.PlaybackStatusFailed, "", clipText(fmt.Sprintf("转码 panic：%v", r), 1000), "panic")
		}
	}()
	if err := ctx.Err(); err != nil {
		releaseClaim(s.store, resourceID)
		return
	}
	key, err := copyObjectKey(resourceID)
	if err != nil {
		s.persistStoppedOrFailed(ctx, resourceID, "", clipText(err.Error(), 1000))
		return
	}
	dst, err := s.copyPath(key)
	if err != nil {
		s.persistStoppedOrFailed(ctx, resourceID, "", clipText(err.Error(), 1000))
		return
	}
	if ProbeCodec(dst) == CodecH264 {
		s.persistReadyOrRelease(ctx, resourceID, dst, key)
		return
	}
	if err := s.transcode(ctx, src, dst); err != nil {
		_ = os.Remove(dst)
		s.persistStoppedOrFailed(ctx, resourceID, dst, clipText(err.Error(), 1000))
		return
	}
	s.persistReadyOrRelease(ctx, resourceID, dst, key)
}

func (s *Service) persistStoppedOrFailed(ctx context.Context, resourceID, dst, errText string) {
	if ctx.Err() != nil {
		if dst != "" {
			_ = os.Remove(dst)
		}
		releaseClaim(s.store, resourceID)
		return
	}
	ok, err := finishPlayback(s.store, resourceID, model.PlaybackStatusFailed, "", errText, "transcode_failed")
	if err != nil || !ok {
		if dst != "" {
			_ = os.Remove(dst)
		}
	}
}

func (s *Service) persistReadyOrRelease(ctx context.Context, resourceID, dst, objectKey string) {
	if ctx.Err() != nil {
		if dst != "" {
			_ = os.Remove(dst)
		}
		releaseClaim(s.store, resourceID)
		return
	}
	ok, err := finishPlayback(s.store, resourceID, model.PlaybackStatusReady, objectKey, "", "transcode_complete")
	if err != nil || !ok {
		if dst != "" {
			_ = os.Remove(dst)
		}
	}
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
// from a crash are reset first. A cursored none-row pass covers codec
// rule changes that previously marked H.265 as playable, including sets
// larger than one batch. ctx cancels the scan without writing READY.
func (s *Service) Backfill(ctx context.Context) error {
	if s == nil || s.store == nil {
		return nil
	}
	ctx = s.runContext(ctx)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.Recover(); err != nil {
		return err
	}
	if err := s.backfillScan(ctx, s.store.PlaybackPendingVideos); err != nil {
		return err
	}
	return s.backfillScan(ctx, s.store.PlaybackNoneVideos)
}

// Recover clears claims left by the previous process exactly once, before any
// new claims from this runtime. Repeated scans must not reset live transcodes.
func (s *Service) Recover() error {
	if s == nil || s.store == nil {
		return nil
	}
	s.recoveryOnce.Do(func() { s.recoveryErr = s.store.ResetStuckPlaybackTranscodes() })
	return s.recoveryErr
}

func (s *Service) backfillScan(ctx context.Context, page func(time.Time, string, int) ([]model.Resource, error)) error {
	var afterTime time.Time
	var afterID string
	for range backfillMaxScan {
		if err := ctx.Err(); err != nil {
			return err
		}
		items, err := page(afterTime, afterID, backfillBatch)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return nil
		}
		last := items[len(items)-1]
		if last.CreatedAt.Equal(afterTime) && last.ID == afterID {
			return errBackfillCursor
		}
		for i := range items {
			if err := ctx.Err(); err != nil {
				return err
			}
			s.MaybeStart(&items[i])
		}
		afterTime, afterID = last.CreatedAt, last.ID
	}
	return errBackfillBound
}
