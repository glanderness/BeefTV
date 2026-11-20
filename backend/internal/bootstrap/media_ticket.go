package bootstrap

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/asset"
	localplayback "infinite-canvas/backend/internal/playback"
)

// serveLoopbackMediaTicket serves strictly scoped, process-ephemeral loopback
// media streams for native <video>/<audio> elements. It runs outside the master
// X-Desktop-Token wrapper so native media pipelines can issue real TCP Range
// requests (including Safari's bytes=0-1 probe) without exposing desktop launch
// credentials or buffering hundreds of megabytes through Wails' AssetServer.
func serveLoopbackMediaTicket(w http.ResponseWriter, r *http.Request, resources *asset.Service, playback *localplayback.Service) {
	if !isLoopbackRemote(r.RemoteAddr) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		if !IsAllowedDesktopOrigin(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, Content-Type")
		w.Header().Set("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Range")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if resources == nil || resources.MediaTickets() == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	trimmed := strings.TrimPrefix(r.URL.Path, "/media/")
	ticketToken, fileName, ok := strings.Cut(trimmed, "/")
	if !ok || ticketToken == "" || fileName == "" || strings.Contains(fileName, "/") {
		http.NotFound(w, r)
		return
	}
	entry, valid := resources.MediaTickets().Lookup(ticketToken)
	if !valid {
		http.Error(w, "invalid or expired media ticket", http.StatusForbidden)
		return
	}
	if fileName != entry.FileName {
		http.NotFound(w, r)
		return
	}

	var seeker io.ReadSeeker
	var closer io.Closer
	mimeType := strings.TrimSpace(entry.MimeType)

	if entry.Variant == "playback" && playback != nil {
		pbStream, pbErr := playback.OpenRange(entry.UserID, entry.ResourceID)
		if pbErr == nil && pbStream != nil {
			if rs, isSeeker := pbStream.Body.(io.ReadSeeker); isSeeker {
				seeker = rs
				closer = pbStream.Body
				mimeType = "video/mp4"
			} else {
				_ = pbStream.Body.Close()
			}
		} else if pbErr != nil && !errors.Is(pbErr, localplayback.ErrNotReady) {
			http.Error(w, "media open failed", http.StatusInternalServerError)
			return
		}
	}

	if seeker == nil {
		stream, err := resources.OpenRange(entry.UserID, entry.ResourceID, "")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		rs, isSeeker := stream.Body.(io.ReadSeeker)
		if !isSeeker {
			_ = stream.Body.Close()
			http.Error(w, "media not seekable", http.StatusInternalServerError)
			return
		}
		seeker = rs
		closer = stream.Body
		if mimeType == "" && stream.Resource != nil {
			mimeType = strings.TrimSpace(stream.Resource.MimeType)
		}
	}
	defer closer.Close()

	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Clone request without If-Range / conditional headers so a mismatched
	// validator can never force a full-file 200 or stale 304.
	cloned := r.Clone(r.Context())
	cloned.Header = r.Header.Clone()
	cloned.Header.Del("If-Range")
	cloned.Header.Del("If-None-Match")
	cloned.Header.Del("If-Modified-Since")
	cloned.Header.Del("If-Unmodified-Since")

	http.ServeContent(w, cloned, entry.FileName, time.Time{}, seeker)
}
