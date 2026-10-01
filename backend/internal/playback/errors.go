package playback

import "errors"

// ErrNotReady means the resource has no usable browser-compatible copy
// (not transcoded, still processing, or failed). File endpoints fall back
// to the original object.
var ErrNotReady = errors.New("播放副本尚未就绪")

var (
	errBackfillCursor = errors.New("playback backfill cursor did not advance")
	errBackfillBound  = errors.New("playback backfill reached scan bound")
)
