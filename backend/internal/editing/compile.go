package editing

import (
	"fmt"
	"sort"
	"strings"
)

// Compile turns a timeline snapshot into a versioned semantic render plan.
// sources may be nil for native compilation (source IDs come from resource:
// keys). When sources is non-nil, every visible video/audio/image clip must
// match an opaque source id; native paths are never accepted.
func Compile(project Project, sources []SourceMeta, opts Options) (*Plan, error) {
	opts = NormalizeOptions(opts)
	sourceIndex, sourcesProvided := indexSources(sources)
	visible := map[string]bool{}
	muted := map[string]bool{}
	for _, track := range project.Tracks {
		visible[track.ID] = track.Visible == nil || *track.Visible
		muted[track.ID] = track.Muted
	}

	plan := &Plan{
		Version: PlanVersion,
		Output: Output{
			Width:         opts.Width,
			Height:        opts.Height,
			FPS:           opts.FPS,
			SampleRate:    opts.SampleRate,
			BurnSubtitles: *opts.BurnSubtitles,
		},
	}

	end := project.DurationMs
	var visual []Clip
	for _, clip := range project.Clips {
		if len(project.Tracks) > 0 && !visible[clip.TrackID] {
			continue
		}
		if clip.StartMs < 0 || clip.SourceStartMs < 0 {
			return plan, ErrNegativeTime
		}
		if clip.Volume < 0 {
			return plan, fmt.Errorf("%w：%s", ErrInvalidVolume, clipLabel(clip))
		}
		if clip.DurationMs > 0 && clip.StartMs+clip.DurationMs > end {
			end = clip.StartMs + clip.DurationMs
		}
		switch clip.Kind {
		case KindAudio:
			if clip.DurationMs <= 0 {
				continue
			}
			sourceID, source, err := resolveSource(clip, sourceIndex, sourcesProvided)
			if err != nil {
				return plan, err
			}
			if err := validateSourceTiming(clip, source, sourcesProvided); err != nil {
				return plan, err
			}
			if source.HasAudio != nil && !*source.HasAudio {
				return plan, ErrMissingAudioTrack
			}
			plan.Audio = append(plan.Audio, AudioClip{
				ClipID:        clip.ID,
				SourceID:      sourceID,
				StartMs:       clip.StartMs,
				DurationMs:    clip.DurationMs,
				SourceStartMs: clip.SourceStartMs,
				Volume:        clip.Volume,
				FadeInMs:      clip.FadeInMs,
				FadeOutMs:     clip.FadeOutMs,
				Muted:         muted[clip.TrackID],
			})
		case KindVideo, KindImage:
			if clip.DurationMs <= 0 {
				continue
			}
			visual = append(visual, clip)
		case KindSubtitle:
			text := strings.TrimSpace(clip.Text)
			if text == "" || clip.DurationMs <= 0 {
				continue
			}
			plan.Subtitles = append(plan.Subtitles, Subtitle{
				ClipID:     clip.ID,
				StartMs:    clip.StartMs,
				DurationMs: clip.DurationMs,
				Text:       text,
			})
		}
	}

	sort.SliceStable(visual, func(i, j int) bool {
		if visual[i].StartMs == visual[j].StartMs {
			return visual[i].ID < visual[j].ID
		}
		return visual[i].StartMs < visual[j].StartMs
	})
	sort.SliceStable(plan.Audio, func(i, j int) bool {
		if plan.Audio[i].StartMs == plan.Audio[j].StartMs {
			return plan.Audio[i].ClipID < plan.Audio[j].ClipID
		}
		return plan.Audio[i].StartMs < plan.Audio[j].StartMs
	})
	sort.SliceStable(plan.Subtitles, func(i, j int) bool {
		if plan.Subtitles[i].StartMs == plan.Subtitles[j].StartMs {
			return plan.Subtitles[i].ClipID < plan.Subtitles[j].ClipID
		}
		return plan.Subtitles[i].StartMs < plan.Subtitles[j].StartMs
	})

	cursor := int64(0)
	for _, clip := range visual {
		if clip.StartMs < cursor {
			return plan, ErrOverlap
		}
		if gap := clip.StartMs - cursor; gap > 0 {
			plan.Segments = append(plan.Segments, gapSegment(cursor, gap))
		}
		sourceID, source, err := resolveSource(clip, sourceIndex, sourcesProvided)
		if err != nil {
			return plan, err
		}
		if err := validateSourceTiming(clip, source, sourcesProvided); err != nil {
			return plan, err
		}
		trackMuted := muted[clip.TrackID]
		hasAudio := clip.Kind == KindVideo && !trackMuted
		if source.HasAudio != nil {
			hasAudio = hasAudio && *source.HasAudio
		}
		if clip.Kind == KindVideo && source.HasVideo != nil && !*source.HasVideo {
			return plan, fmt.Errorf("%w：%s", ErrMissingVideoTrack, clipLabel(clip))
		}
		if clip.Kind == KindImage {
			hasAudio = false
		}
		plan.Segments = append(plan.Segments, Segment{
			Kind:          clip.Kind,
			ClipID:        clip.ID,
			SourceID:      sourceID,
			StartMs:       clip.StartMs,
			DurationMs:    clip.DurationMs,
			SourceStartMs: clip.SourceStartMs,
			Volume:        clip.Volume,
			FadeInMs:      clip.FadeInMs,
			FadeOutMs:     clip.FadeOutMs,
			Muted:         trackMuted,
			HasAudio:      hasAudio,
		})
		cursor = clip.StartMs + clip.DurationMs
	}
	if end > cursor {
		plan.Segments = append(plan.Segments, gapSegment(cursor, end-cursor))
	}
	plan.DurationMs = 0
	for _, seg := range plan.Segments {
		plan.DurationMs += seg.DurationMs
	}
	if *opts.BurnSubtitles {
		plan.SubtitleSRT = buildSubtitleSRT(plan.Subtitles)
	} else {
		plan.Subtitles = nil
		plan.SubtitleSRT = ""
	}
	if !plan.HasMedia() {
		return plan, ErrNoMedia
	}
	return plan, nil
}

func gapSegment(startMs, durationMs int64) Segment {
	return Segment{Kind: KindGap, StartMs: startMs, DurationMs: durationMs, Volume: 1}
}

func indexSources(sources []SourceMeta) (map[string]SourceMeta, bool) {
	if sources == nil {
		return nil, false
	}
	index := make(map[string]SourceMeta, len(sources))
	for _, source := range sources {
		id := strings.TrimSpace(source.ID)
		if id == "" {
			continue
		}
		index[id] = source
	}
	return index, true
}

func resolveSource(clip Clip, index map[string]SourceMeta, sourcesProvided bool) (string, SourceMeta, error) {
	candidates := clipSourceCandidates(clip)
	if sourcesProvided {
		for _, id := range candidates {
			if source, ok := index[id]; ok {
				return id, source, nil
			}
		}
		return "", SourceMeta{}, fmt.Errorf("%w：%s", ErrMissingSource, clipLabel(clip))
	}
	if id, ok := MediaResourceID(clip); ok {
		return id, SourceMeta{ID: id}, nil
	}
	return "", SourceMeta{}, fmt.Errorf("%w：%s", ErrMissingMediaRef, clip.ID)
}

func clipSourceCandidates(clip Clip) []string {
	var ids []string
	if node := strings.TrimSpace(clip.NodeID); node != "" {
		ids = append(ids, node)
	}
	if id, ok := MediaResourceID(clip); ok {
		ids = append(ids, id, "resource:"+id)
	}
	if clip.DirectMedia != nil {
		if id := strings.TrimSpace(clip.DirectMedia.ID); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func validateSourceTiming(clip Clip, source SourceMeta, sourcesProvided bool) error {
	if clip.DurationMs <= 0 {
		return fmt.Errorf("%w：%s", ErrInvalidClip, clip.ID)
	}
	if !sourcesProvided || source.DurationMs <= 0 || clip.Kind == KindImage {
		return nil
	}
	if clip.SourceStartMs+clip.DurationMs > source.DurationMs+DurationToleranceMs {
		return fmt.Errorf("%w：%s", ErrInsufficientDuration, clipLabel(clip))
	}
	return nil
}

func clipLabel(clip Clip) string {
	if strings.TrimSpace(clip.ID) != "" {
		return clip.ID
	}
	if strings.TrimSpace(clip.NodeID) != "" {
		return clip.NodeID
	}
	return "clip"
}
