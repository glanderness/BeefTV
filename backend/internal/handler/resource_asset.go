package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	localplayback "infinite-canvas/backend/internal/playback"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const mediaTicketBodyCapJSON = 4 << 10

func registerResourceAssetRoutes(r *gin.RouterGroup, owners workspaceOwners, resources *asset.Service, playback *localplayback.Service) {
	serveAsset := func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if resources == nil {
			failService(c, asset.ResourceMissing())
			return
		}
		resourceID := c.Param("id")
		variant := strings.ToLower(strings.TrimSpace(c.Query("variant")))
		filename := strings.ToLower(strings.TrimSpace(c.Param("filename")))
		if variant == "" {
			if strings.HasPrefix(filename, "poster") {
				variant = "poster"
			} else if strings.HasPrefix(filename, "preview") {
				variant = "preview"
			} else {
				variant = "original"
			}
		}

		switch variant {
		case "preview":
			w, _ := strconv.Atoi(strings.TrimSpace(c.Query("w")))
			color := asset.NormalizePreviewColorMode(c.Query("color"))
			result, previewErr := resources.OpenImagePreview(c.Request.Context(), user.ID, resourceID, w, color)
			if previewErr != nil {
				failService(c, previewErr)
				return
			}
			serveImmutablePreviewFile(c, result)
			return

		case "poster":
			result, posterErr := resources.OpenVideoPoster(c.Request.Context(), user.ID, resourceID)
			if posterErr != nil {
				failService(c, posterErr)
				return
			}
			serveImmutablePreviewFile(c, result)
			return

		case "original", "playback":
			serveClampedAssetRange(c, user.ID, resourceID, variant == "playback", resources, playback)
			return

		default:
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("不支持的素材变体"))
			return
		}
	}

	r.GET("/resources/:id/asset", serveAsset)
	r.HEAD("/resources/:id/asset", serveAsset)
	r.GET("/resources/:id/asset/:filename", serveAsset)
	r.HEAD("/resources/:id/asset/:filename", serveAsset)

	r.POST("/resources/:id/media-ticket", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if resources == nil || resources.MediaTickets() == nil {
			failService(c, asset.ResourceMissing())
			return
		}
		var req struct {
			Variant string `json:"variant"`
		}
		if c.Request.Body != nil && c.Request.ContentLength != 0 {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, mediaTicketBodyCapJSON)
			if bindErr := c.ShouldBindJSON(&req); bindErr != nil && !errors.Is(bindErr, io.EOF) {
				fail(c, http.StatusBadRequest, kernel.BadAuthRequest("无效的媒体票据请求"))
				return
			}
		}
		resource, err := resources.Resource(user.ID, c.Param("id"))
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				failService(c, asset.ResourceNotFound())
				return
			}
			failService(c, err)
			return
		}
		if resource.Status != model.ResourceStatusReady {
			failService(c, asset.ResourceNotReady())
			return
		}
		if resource.Provider != "local" {
			failService(c, asset.ResourceNotLocal())
			return
		}
		variant := "original"
		mimeType := strings.TrimSpace(resource.MimeType)
		if strings.EqualFold(strings.TrimSpace(req.Variant), "playback") &&
			resource.PlaybackStatus == model.PlaybackStatusReady &&
			resource.PlaybackObjectKey != "" {
			variant = "playback"
			mimeType = "video/mp4"
		}
		ext := mediaExtensionForResource(mimeType, resource.ObjectKey, resource.Kind)
		fileName := resource.ID + ext
		token, expiresAt, err := resources.MediaTickets().Issue(user.ID, resource.ID, variant, fileName, mimeType)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{
			"ticket":    token,
			"path":      "/media/" + token + "/" + fileName,
			"expiresAt": expiresAt.UTC().Format(time.RFC3339),
			"mimeType":  mimeType,
			"size":      resource.Size,
			"variant":   variant,
		})
	})
}

func serveImmutablePreviewFile(c *gin.Context, result *asset.PreviewResult) {
	if result == nil || strings.TrimSpace(result.Path) == "" {
		fail(c, http.StatusNotFound, asset.ResourceFileMissing())
		return
	}
	file, err := os.Open(result.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fail(c, http.StatusNotFound, asset.ResourceFileMissing())
			return
		}
		failService(c, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		failService(c, err)
		return
	}
	mimeType := strings.TrimSpace(result.MimeType)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	// Only set long-lived immutable caching on verified disk previews or
	// intentionally original assets (already <= tier or animated). Transient
	// fallbacks must never be pinned in browser cache for a year.
	if result.Immutable {
		c.Header("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "no-store")
	}
	c.Header("Content-Disposition", "inline")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Type", mimeType)
	c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))
	if c.Request.Method == http.MethodHead {
		c.Status(http.StatusOK)
		return
	}
	c.DataFromReader(http.StatusOK, info.Size(), mimeType, file, nil)
}

func serveClampedAssetRange(c *gin.Context, userID, resourceID string, wantPlayback bool, resources *asset.Service, playback *localplayback.Service) {
	rangeHeader := c.GetHeader("Range")
	// Deliberately ignore If-Range: a stale If-Range on Wails AssetServer would
	// degrade a seek into a full-file 200 inside bytes.Buffer.
	var stream *assets.ResourceStream
	var err error
	if wantPlayback && playback != nil {
		playbackStream, pbErr := playback.OpenRange(userID, resourceID)
		if pbErr == nil && playbackStream != nil {
			defer playbackStream.Body.Close()
			if seeker, ok := playbackStream.Body.(io.ReadSeeker); ok {
				serveClampedSeeker(c, "video/mp4", seeker, playbackStream.ContentLength, rangeHeader)
				return
			}
		} else if pbErr != nil && !errors.Is(pbErr, localplayback.ErrNotReady) {
			failService(c, pbErr)
			return
		}
	}
	stream, err = resources.OpenClampedRange(userID, resourceID, rangeHeader, asset.DefaultAssetMaxChunkBytes)
	if err != nil {
		failService(c, err)
		return
	}
	defer stream.Body.Close()

	mimeType := strings.TrimSpace(stream.Resource.MimeType)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Disposition", "inline")
	c.Header("X-Content-Type-Options", "nosniff")
	if stream.ContentRange != "" {
		c.Header("Content-Range", stream.ContentRange)
	}
	if stream.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		c.Status(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	c.Header("Content-Type", mimeType)
	c.Header("Content-Length", strconv.FormatInt(stream.ContentLength, 10))
	if c.Request.Method == http.MethodHead {
		c.Status(stream.StatusCode)
		return
	}
	c.DataFromReader(stream.StatusCode, stream.ContentLength, mimeType, stream.Body, nil)
}

func serveClampedSeeker(c *gin.Context, mimeType string, seeker io.ReadSeeker, size int64, rangeHeader string) {
	c.Header("Cache-Control", "no-store")
	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Disposition", "inline")
	c.Header("X-Content-Type-Options", "nosniff")
	mimeType = strings.TrimSpace(mimeType)
	if mimeType == "" {
		mimeType = "video/mp4"
	}
	normalized := asset.NormalizeSingleByteRange(rangeHeader)
	if normalized == "" {
		if size > asset.DefaultAssetMaxChunkBytes {
			c.Header("Content-Range", fmt.Sprintf("bytes */%d", size))
			c.Status(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		c.Header("Content-Type", mimeType)
		c.Header("Content-Length", strconv.FormatInt(size, 10))
		if c.Request.Method == http.MethodHead {
			c.Status(http.StatusOK)
			return
		}
		c.DataFromReader(http.StatusOK, size, mimeType, seeker, nil)
		return
	}
	clamped := asset.ClampByteRange(normalized, size, asset.DefaultAssetMaxChunkBytes)
	spec := strings.TrimPrefix(clamped, "bytes=")
	startStr, endStr, found := strings.Cut(spec, "-")
	start, err1 := strconv.ParseInt(startStr, 10, 64)
	end, err2 := strconv.ParseInt(endStr, 10, 64)
	if !found || err1 != nil || err2 != nil || start < 0 || end < start || start >= size {
		c.Header("Content-Range", fmt.Sprintf("bytes */%d", size))
		c.Status(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if end >= size {
		end = size - 1
	}
	if _, err := seeker.Seek(start, io.SeekStart); err != nil {
		failService(c, err)
		return
	}
	length := end - start + 1
	c.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	c.Header("Content-Type", mimeType)
	c.Header("Content-Length", strconv.FormatInt(length, 10))
	if c.Request.Method == http.MethodHead {
		c.Status(http.StatusPartialContent)
		return
	}
	c.DataFromReader(http.StatusPartialContent, length, mimeType, io.LimitReader(seeker, length), nil)
}

func mediaExtensionForResource(mimeType, objectKey, kind string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "video/quicktime":
		return ".mov"
	case "video/x-matroska":
		return ".mkv"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/mp4", "audio/x-m4a", "audio/aac":
		return ".m4a"
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/ogg":
		return ".ogg"
	case "audio/webm":
		return ".weba"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	}
	if ext := strings.ToLower(filepath.Ext(strings.TrimSpace(objectKey))); len(ext) >= 2 && len(ext) <= 6 {
		return ext
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "video":
		return ".mp4"
	case "audio":
		return ".mp3"
	case "image":
		return ".jpg"
	default:
		return ".bin"
	}
}
