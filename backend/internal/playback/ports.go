package playback

import "infinite-canvas/backend/internal/model"

const (
	DirName         = "playback"
	CodecH264       = "h264"
	CodecH265       = "h265"
	CodecAV1        = "av1"
	CodecVP9        = "vp9"
	CodecMPEG4      = "mpeg4"
	PersistAttempts = 3
	probeMaxMoov    = 128 << 20
	backfillBatch   = 20
)

// Store is the durable playback-status port. Adapters wrap the existing
// resource repository; this package never opens a second ledger.
type Store interface {
	ResourceForUser(userID string, id string) (*model.Resource, error)
	SaveResource(*model.Resource) error
	ClaimPlaybackTranscode(id string) (bool, error)
	ResetStuckPlaybackTranscodes() error
	PlaybackPendingVideos(limit int) ([]model.Resource, error)
	PlaybackNoneVideos(limit int) ([]model.Resource, error)
}

// Runner starts background transcode on the shared worker lifecycle.
// Go reports whether the work was accepted by that owner.
type Runner interface {
	Go(func()) bool
}

// Deps constructs the playback domain. DataDir is the workspace root.
type Deps struct {
	DataDir   string
	Store     Store
	Runner    Runner
	LookPath  func(file string) (string, error)
	Transcode func(src string, dst string) error
}
