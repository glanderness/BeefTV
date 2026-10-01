// Package playback owns browser-compatible playback copies of local videos.
//
// The domain probes MP4 codecs and generated-media dimensions, claims a
// transcode, runs ffmpeg, persists status, serves the copy for range reads,
// and backfills leftover or legacy rows. It must not import internal/app.
// File bytes live under dataDir/playback; original media stays in the
// resource store. Background work uses the injected Runner (the shared
// platform.Worker) so transcode is not an unowned goroutine.
package playback
