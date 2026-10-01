package asset

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

const (
	ChunkUploadSize       = 8 << 20
	chunkUploadSlackBytes = 64 << 10
	chunkUploadTTL        = 90 * time.Minute
	chunkUploadMaxPerUser = 32
	chunkSessionMetaName  = "meta.json"
	chunkSessionDirName   = "chunk-sessions"
)

type ChunkedUploadStart struct {
	FileName       string
	Kind           string
	Size           int64
	Width          int
	Height         int
	DurationMs     int64
	IdempotencyKey string
}

type ChunkedUploadSessionInfo struct {
	UploadID   string
	ChunkSize  int
	ChunkCount int
}

type chunkedUploadSession struct {
	ID          string
	UserID      string
	FileName    string
	Kind        string
	Size        int64
	Width       int
	Height      int
	DurationMs  int64
	Identity    string
	Day         string
	ChunkCount  int
	Dir         string
	CreatedAt   time.Time
	completing  bool
	done        chan struct{}
	complete    *model.Resource
	completeErr error
}

type chunkSessionMeta struct {
	ID         string    `json:"id"`
	UserID     string    `json:"userId"`
	FileName   string    `json:"fileName"`
	Kind       string    `json:"kind"`
	Size       int64     `json:"size"`
	Width      int       `json:"width"`
	Height     int       `json:"height"`
	DurationMs int64     `json:"durationMs"`
	Identity   string    `json:"identity"`
	Day        string    `json:"day"`
	ChunkCount int       `json:"chunkCount"`
	CreatedAt  time.Time `json:"createdAt"`
}

func (s *Service) sessionRoot() string {
	if s == nil || strings.TrimSpace(s.dataDir) == "" {
		return ""
	}
	return filepath.Join(s.dataDir, chunkSessionDirName)
}

func newUploadSessionID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func chunkedIdentity(sessionID, idempotencyKey string) string {
	if key := NormalizedUploadKey([]string{idempotencyKey}); key != nil {
		return *key
	}
	return strings.TrimSpace(sessionID)
}

func (sess *chunkedUploadSession) chunkPath(index int) string {
	return filepath.Join(sess.Dir, fmt.Sprintf("chunk-%d", index))
}

func (sess *chunkedUploadSession) chunkSizeAt(index int) int64 {
	if sess == nil || index < 0 || index >= sess.ChunkCount {
		return 0
	}
	if index == sess.ChunkCount-1 {
		rest := sess.Size - int64(index)*ChunkUploadSize
		if rest < 0 {
			return 0
		}
		return rest
	}
	return ChunkUploadSize
}

func (sess *chunkedUploadSession) hasAllChunks() bool {
	if sess == nil {
		return false
	}
	for i := 0; i < sess.ChunkCount; i++ {
		info, err := os.Stat(sess.chunkPath(i))
		if err != nil || info.Size() != sess.chunkSizeAt(i) {
			return false
		}
	}
	return true
}

func (s *Service) StartChunkedUpload(userID string, req ChunkedUploadStart) (ChunkedUploadSessionInfo, error) {
	if s == nil || s.repo == nil {
		return ChunkedUploadSessionInfo{}, ResourceMissing()
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ChunkedUploadSessionInfo{}, ResourceMissing()
	}
	req.FileName = strings.TrimSpace(req.FileName)
	if req.FileName == "" || len(req.FileName) > 255 {
		return ChunkedUploadSessionInfo{}, kernel.BadAuthRequest("文件名不能为空且不能超过 255 个字符")
	}
	if req.Size <= 0 {
		return ChunkedUploadSessionInfo{}, kernel.BadAuthRequest("文件大小必须大于 0")
	}
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	s.expireSessionsLocked(time.Now())
	identity := chunkedIdentity("", req.IdempotencyKey)
	if identity != "" {
		if existing := s.liveSessionByIdentityLocked(userID, identity); existing != nil {
			return ChunkedUploadSessionInfo{UploadID: existing.ID, ChunkSize: ChunkUploadSize, ChunkCount: existing.ChunkCount}, nil
		}
		if ready, err := s.readyResourceByIdentity(userID, identity); err != nil {
			return ChunkedUploadSessionInfo{}, err
		} else if ready != nil {
			stub := s.rememberCompletedLocked(userID, identity, ready, req)
			return ChunkedUploadSessionInfo{UploadID: stub.ID, ChunkSize: ChunkUploadSize, ChunkCount: stub.ChunkCount}, nil
		}
	}
	active := 0
	for _, sess := range s.sessions {
		if sess != nil && sess.UserID == userID && sess.complete == nil {
			active++
		}
	}
	if active >= chunkUploadMaxPerUser {
		return ChunkedUploadSessionInfo{}, UploadSessionBusy()
	}
	sessionID := newUploadSessionID()
	if identity == "" {
		identity = sessionID
	}
	day, err := s.reserveChunked(userID, req.Size, identity)
	if err != nil {
		return ChunkedUploadSessionInfo{}, err
	}
	dir, err := s.createSessionDir(sessionID)
	if err != nil {
		s.quotaRelease(userID, day, req.Size, identity)
		return ChunkedUploadSessionInfo{}, err
	}
	chunkCount := int((req.Size + ChunkUploadSize - 1) / ChunkUploadSize)
	sess := &chunkedUploadSession{
		ID: sessionID, UserID: userID, FileName: req.FileName, Kind: req.Kind,
		Size: req.Size, Width: req.Width, Height: req.Height, DurationMs: req.DurationMs,
		Identity: identity, Day: day, ChunkCount: chunkCount, Dir: dir, CreatedAt: time.Now(),
	}
	if err := writeSessionMeta(sess); err != nil {
		_ = os.RemoveAll(dir)
		s.quotaRelease(userID, day, req.Size, identity)
		return ChunkedUploadSessionInfo{}, err
	}
	s.sessions[sessionID] = sess
	return ChunkedUploadSessionInfo{UploadID: sessionID, ChunkSize: ChunkUploadSize, ChunkCount: chunkCount}, nil
}

func (s *Service) PutChunkedUpload(userID, uploadID string, index int, body io.Reader) error {
	if s == nil {
		return UploadSessionMissing()
	}
	userID = strings.TrimSpace(userID)
	s.sessionMu.Lock()
	s.expireSessionsLocked(time.Now())
	sess := s.sessions[strings.TrimSpace(uploadID)]
	s.sessionMu.Unlock()
	if sess == nil || sess.UserID != userID {
		return UploadSessionMissing()
	}
	if sess.complete != nil {
		return nil
	}
	expected := sess.chunkSizeAt(index)
	if expected <= 0 {
		return UploadChunkIndexInvalid()
	}
	limited := &io.LimitedReader{R: body, N: expected + chunkUploadSlackBytes + 1}
	dst, err := os.OpenFile(sess.chunkPath(index), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	written, copyErr := io.CopyN(dst, limited, expected)
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil || written != expected {
		_ = os.Remove(sess.chunkPath(index))
		return UploadChunkIncomplete(index)
	}
	var probe [1]byte
	if extra, readErr := limited.Read(probe[:]); readErr == nil || extra > 0 {
		_ = os.Remove(sess.chunkPath(index))
		return UploadChunkTooLarge(index)
	}
	return nil
}

func (s *Service) CompleteChunkedUpload(userID, uploadID string) (*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	userID = strings.TrimSpace(userID)
	uploadID = strings.TrimSpace(uploadID)
	s.sessionMu.Lock()
	s.expireSessionsLocked(time.Now())
	sess := s.sessions[uploadID]
	if sess == nil || sess.UserID != userID {
		s.sessionMu.Unlock()
		return s.completeMissingSession(userID, uploadID)
	}
	if sess.complete != nil {
		resource := sess.complete
		s.sessionMu.Unlock()
		return resource, nil
	}
	if sess.completing {
		done := sess.done
		s.sessionMu.Unlock()
		<-done
		s.sessionMu.Lock()
		resource, err := sess.complete, sess.completeErr
		s.sessionMu.Unlock()
		if resource != nil && err == nil {
			return resource, nil
		}
		if err != nil {
			return nil, err
		}
		return s.CompleteChunkedUpload(userID, uploadID)
	}
	sess.completing = true
	sess.done = make(chan struct{})
	s.sessionMu.Unlock()
	resource, err := s.completeSessionWork(sess)
	s.sessionMu.Lock()
	if err == nil && resource != nil && resource.Status == model.ResourceStatusReady {
		sess.complete = resource
		sess.completeErr = nil
		s.dropSessionFilesLocked(sess)
	} else {
		sess.completeErr = err
		sess.completing = false
		if resource != nil && s.objectPresent(resource) {
			s.dropSessionFilesLocked(sess)
		}
	}
	close(sess.done)
	s.sessionMu.Unlock()
	if err != nil {
		return nil, err
	}
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return nil, UploadSessionIncomplete()
	}
	return resource, nil
}

func (s *Service) completeMissingSession(userID, uploadID string) (*model.Resource, error) {
	if ready, err := s.readyResourceByIdentity(userID, uploadID); err != nil {
		return nil, err
	} else if ready != nil {
		return ready, nil
	}
	return nil, UploadSessionMissing()
}

func (s *Service) completeSessionWork(sess *chunkedUploadSession) (*model.Resource, error) {
	if sess == nil {
		return nil, UploadSessionMissing()
	}
	identity := sess.Identity
	uploadKey := identity
	if existing, err := s.resourceForUploadKey(sess.UserID, &uploadKey); err != nil {
		return nil, err
	} else if existing != nil {
		if existing.Status == model.ResourceStatusReady {
			s.quotaCommit(sess.UserID, sess.Size, identity)
			return existing, nil
		}
		if s.objectPresent(existing) {
			return s.promoteReady(existing)
		}
		body, err := s.openSessionBody(sess)
		if err != nil {
			return nil, err
		}
		return s.RetryOwned(sess.UserID, existing.ID, existing.Kind, existing.MimeType, sess.Size, body)
	}
	body, err := s.openSessionBody(sess)
	if err != nil {
		return nil, err
	}
	mimeType := DetectUploadedMimeType(body, sess.FileName, "")
	_, _ = body.Seek(0, io.SeekStart)
	resource, _, err := s.Store(sess.UserID, sess.Kind, sess.FileName, mimeType, sess.Size, sess.Width, sess.Height, sess.DurationMs, body, &uploadKey)
	s.finishQuota(sess.UserID, sess.Day, sess.Size, resource, err, identity)
	return resource, err
}

func (s *Service) openSessionBody(sess *chunkedUploadSession) (*bytes.Reader, error) {
	if sess == nil || !sess.hasAllChunks() {
		return nil, UploadSessionIncomplete()
	}
	files := make([]*os.File, 0, sess.ChunkCount)
	readers := make([]io.Reader, 0, sess.ChunkCount)
	cleanup := func() {
		for _, file := range files {
			_ = file.Close()
		}
	}
	for i := 0; i < sess.ChunkCount; i++ {
		file, err := os.Open(sess.chunkPath(i))
		if err != nil {
			cleanup()
			return nil, UploadSessionIncomplete()
		}
		files = append(files, file)
		readers = append(readers, file)
	}
	buffer, err := io.ReadAll(io.MultiReader(readers...))
	cleanup()
	if err != nil {
		return nil, err
	}
	if int64(len(buffer)) != sess.Size {
		return nil, UploadSessionIncomplete()
	}
	return bytes.NewReader(buffer), nil
}

func (s *Service) readyResourceByIdentity(userID, identity string) (*model.Resource, error) {
	identity = strings.TrimSpace(identity)
	if identity == "" {
		return nil, nil
	}
	resource, err := s.resourceForUploadKey(userID, &identity)
	if err != nil || resource == nil {
		return resource, err
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	return nil, nil
}

func (s *Service) liveSessionByIdentityLocked(userID, identity string) *chunkedUploadSession {
	for _, sess := range s.sessions {
		if sess != nil && sess.UserID == userID && sess.Identity == identity {
			return sess
		}
	}
	return nil
}

func (s *Service) rememberCompletedLocked(userID, identity string, ready *model.Resource, req ChunkedUploadStart) *chunkedUploadSession {
	sessionID := newUploadSessionID()
	chunkCount := int((req.Size + ChunkUploadSize - 1) / ChunkUploadSize)
	if chunkCount < 1 {
		chunkCount = 1
	}
	sess := &chunkedUploadSession{
		ID: sessionID, UserID: userID, FileName: req.FileName, Kind: req.Kind,
		Size: req.Size, Width: req.Width, Height: req.Height, DurationMs: req.DurationMs,
		Identity: identity, ChunkCount: chunkCount, CreatedAt: time.Now(),
		complete: ready,
	}
	s.sessions[sessionID] = sess
	return sess
}

func (s *Service) createSessionDir(sessionID string) (string, error) {
	root := s.sessionRoot()
	if root == "" {
		return "", kernel.BadAuthRequest("上传会话无法创建")
	}
	dir := filepath.Join(root, sessionID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	return dir, nil
}

func writeSessionMeta(sess *chunkedUploadSession) error {
	if sess == nil || sess.Dir == "" {
		return nil
	}
	payload, err := json.Marshal(chunkSessionMeta{
		ID: sess.ID, UserID: sess.UserID, FileName: sess.FileName, Kind: sess.Kind,
		Size: sess.Size, Width: sess.Width, Height: sess.Height, DurationMs: sess.DurationMs,
		Identity: sess.Identity, Day: sess.Day, ChunkCount: sess.ChunkCount, CreatedAt: sess.CreatedAt,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(sess.Dir, chunkSessionMetaName), payload, 0o600)
}

func (s *Service) quotaRelease(userID, day string, size int64, identity string) {
	if s == nil || s.quota == nil {
		return
	}
	s.quota.Release(userID, day, size, identity)
}

func (s *Service) quotaCommit(userID string, size int64, identity string) {
	if s == nil || s.quota == nil {
		return
	}
	s.quota.Commit(userID, size, identity)
}

func (s *Service) dropSessionFilesLocked(sess *chunkedUploadSession) {
	if sess == nil || sess.Dir == "" {
		return
	}
	_ = os.RemoveAll(sess.Dir)
	sess.Dir = ""
}

func (s *Service) expireSessionsLocked(now time.Time) {
	for id, sess := range s.sessions {
		if sess == nil {
			delete(s.sessions, id)
			continue
		}
		if sess.complete != nil {
			if now.Sub(sess.CreatedAt) > chunkUploadTTL {
				s.dropSessionFilesLocked(sess)
				delete(s.sessions, id)
			}
			continue
		}
		if now.Sub(sess.CreatedAt) <= chunkUploadTTL {
			continue
		}
		s.releaseAbandonedSession(sess)
		delete(s.sessions, id)
	}
}

func (s *Service) releaseAbandonedSession(sess *chunkedUploadSession) {
	if sess == nil {
		return
	}
	existing, _ := s.resourceForUploadKey(sess.UserID, &sess.Identity)
	if existing == nil {
		s.quotaRelease(sess.UserID, sess.Day, sess.Size, sess.Identity)
	}
	s.dropSessionFilesLocked(sess)
}

func (s *Service) abandonStaleSessions() {
	root := s.sessionRoot()
	if root == "" {
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		payload, readErr := os.ReadFile(filepath.Join(dir, chunkSessionMetaName))
		if readErr != nil {
			_ = os.RemoveAll(dir)
			continue
		}
		var meta chunkSessionMeta
		if json.Unmarshal(payload, &meta) != nil || strings.TrimSpace(meta.UserID) == "" {
			_ = os.RemoveAll(dir)
			continue
		}
		existing, _ := s.resourceForUploadKey(meta.UserID, &meta.Identity)
		if existing == nil {
			s.quotaRelease(meta.UserID, meta.Day, meta.Size, meta.Identity)
		}
		_ = os.RemoveAll(dir)
	}
}
