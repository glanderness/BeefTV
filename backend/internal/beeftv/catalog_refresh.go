package beeftv

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultCatalogSyncInterval = 15 * time.Minute
	DefaultFocusSyncCooldown   = 2 * time.Minute
	catalogSyncPersistInterval = time.Minute
)

type CatalogSyncOptions struct {
	Force      bool
	BypassETag bool
	Cooldown   time.Duration
}

type catalogRefreshCall struct {
	done       chan struct{}
	bypassETag bool
	models     []CatalogModel
	err        error
}

func (s *Service) canSyncCatalogStateLocked() bool {
	if s.closed || !s.state.hasCredential() || !s.state.Acked {
		return false
	}
	return s.state.Status == StateConnected || s.state.Status == StateCatalogFailed
}

func (s *Service) recordCatalogWriteLocked(configRev int64) {
	if s.state.CatalogVersion > s.catalogVersion {
		s.catalogVersion = s.state.CatalogVersion
	}
	s.catalogVersion++
	s.state.CatalogVersion = s.catalogVersion
	if configRev > 0 {
		s.state.CatalogConfigRevision = configRev
	}
}

func (s *Service) catalogFailureBackoffLocked() time.Duration {
	if s.catalogFailures <= 0 {
		return 0
	}
	base := 30 * time.Second
	maxBackoff := DefaultCatalogSyncInterval
	if s.catalogSyncInterval > 0 {
		if s.catalogSyncInterval < base {
			base = s.catalogSyncInterval
		}
		if s.catalogSyncInterval > maxBackoff {
			maxBackoff = s.catalogSyncInterval
		}
	}
	backoff := base
	for i := 1; i < s.catalogFailures && backoff < maxBackoff; i++ {
		backoff *= 2
	}
	if backoff > maxBackoff {
		return maxBackoff
	}
	return backoff
}

func (s *Service) noteCatalogFailureLocked() {
	s.lastCatalogAttemptAt = s.now()
	s.catalogFailures++
}

// RefreshCatalog fetches and persists prices through the saved connection. A
// client config write must never supply the managed catalog's trusted prices.
func (s *Service) RefreshCatalog(ctx context.Context) ([]CatalogModel, error) {
	return s.refreshCatalog(ctx, CatalogSyncOptions{Force: true, BypassETag: true})
}

// SyncCatalogIfNeeded checks whether the official catalog is due for a silent
// refresh, honoring cooldowns, failure backoff, ETag 304 shortcuts, client-version
// upgrades, catalog_failed self-healing, and singleflight coalescing.
func (s *Service) SyncCatalogIfNeeded(ctx context.Context, opts CatalogSyncOptions) (Summary, error) {
	if ctx == nil {
		ctx = s.lifecycle
	}
	if err := ctx.Err(); err != nil {
		return s.Status(), err
	}
	s.mu.Lock()
	canSync := s.canSyncCatalogStateLocked()
	state := s.state
	lastCheck := s.lastCatalogCheckAt
	lastAttempt := s.lastCatalogAttemptAt
	pendingETag := s.pendingCatalogETag
	backoff := s.catalogFailureBackoffLocked()
	s.mu.Unlock()
	if !canSync {
		return s.Status(), nil
	}
	now := s.now()
	if !opts.BypassETag && backoff > 0 && !lastAttempt.IsZero() && now.Sub(lastAttempt) < backoff {
		return s.Status(), nil
	}
	versionChanged := strings.TrimSpace(state.CatalogClientVersion) != strings.TrimSpace(s.clientVersion)
	etagChanged := pendingETag != "" && pendingETag != state.CatalogETag
	recoveringCatalog := state.Status == StateCatalogFailed
	if !opts.Force && !versionChanged && !etagChanged && !recoveringCatalog && opts.Cooldown > 0 {
		referenceTime := lastCheck
		if referenceTime.IsZero() {
			referenceTime = parseTime(state.CatalogSyncedAt)
		}
		if !referenceTime.IsZero() && now.Sub(referenceTime) < opts.Cooldown {
			return s.Status(), nil
		}
	}
	if versionChanged || recoveringCatalog {
		opts.BypassETag = true
	}
	_, err := s.refreshCatalog(ctx, opts)
	return s.Status(), err
}

// NoteRemoteCatalogETag inspects a piggybacked X-BeefTV-Catalog-ETag value from
// any official compute response. Matching ETags renew freshness without network
// traffic; mismatched ETags trigger a silent background refresh subject to backoff.
func (s *Service) NoteRemoteCatalogETag(raw string) {
	etag := strings.TrimSpace(raw)
	if etag == "" {
		return
	}
	s.mu.Lock()
	if !s.canSyncCatalogStateLocked() {
		s.mu.Unlock()
		return
	}
	now := s.now()
	if s.state.Status == StateConnected && etag == s.state.CatalogETag &&
		s.state.CatalogInlinePricing &&
		strings.TrimSpace(s.state.CatalogClientVersion) == strings.TrimSpace(s.clientVersion) {
		s.lastCatalogCheckAt = now
		s.catalogFailures = 0
		s.pendingCatalogETag = ""
		syncedAt := parseTime(s.state.CatalogSyncedAt)
		if syncedAt.IsZero() || now.Sub(syncedAt) >= catalogSyncPersistInterval {
			s.state.CatalogSyncedAt = now.UTC().Format(time.RFC3339Nano)
			_ = s.persistState(s.state)
		}
		s.mu.Unlock()
		return
	}
	s.pendingCatalogETag = etag
	if s.catalogInFlight != nil {
		s.mu.Unlock()
		return
	}
	if backoff := s.catalogFailureBackoffLocked(); backoff > 0 && !s.lastCatalogAttemptAt.IsZero() && now.Sub(s.lastCatalogAttemptAt) < backoff {
		s.mu.Unlock()
		return
	}
	s.workers.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.workers.Done()
		_, _ = s.SyncCatalogIfNeeded(s.lifecycle, CatalogSyncOptions{Force: true})
	}()
}

func (s *Service) startCatalogSyncLoop() {
	s.mu.Lock()
	if s.closed || s.catalogSyncStarted || s.catalogSyncInterval <= 0 {
		s.mu.Unlock()
		return
	}
	interval := s.catalogSyncInterval
	s.catalogSyncStarted = true
	s.workers.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.workers.Done()
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-s.lifecycle.Done():
				return
			case <-timer.C:
			}
			_, _ = s.SyncCatalogIfNeeded(s.lifecycle, CatalogSyncOptions{Cooldown: interval / 2})
			timer.Reset(interval)
		}
	}()
}

func (s *Service) refreshCatalog(ctx context.Context, opts CatalogSyncOptions) ([]CatalogModel, error) {
	if ctx == nil {
		ctx = s.lifecycle
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return nil, errors.New("企业连接服务已关闭")
		}
		if existing := s.catalogInFlight; existing != nil {
			s.mu.Unlock()
			select {
			case <-existing.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-s.lifecycle.Done():
				return nil, s.lifecycle.Err()
			}
			// If the caller required a full uncached fetch and the coalesced call
			// used conditional ETag validation, loop once to run a forced fetch.
			if opts.BypassETag && !existing.bypassETag && existing.err == nil {
				continue
			}
			return existing.models, existing.err
		}
		call := &catalogRefreshCall{
			done:       make(chan struct{}),
			bypassETag: opts.BypassETag,
		}
		observedPending := s.pendingCatalogETag
		s.pendingCatalogETag = ""
		s.catalogInFlight = call
		s.workers.Add(1)
		s.mu.Unlock()

		models, err := s.executeCatalogRefresh(ctx, opts)

		s.mu.Lock()
		call.models = models
		call.err = err
		if s.catalogInFlight == call {
			s.catalogInFlight = nil
		}
		needFollowUp := err == nil && s.canSyncCatalogStateLocked() &&
			s.pendingCatalogETag != "" && s.pendingCatalogETag != observedPending && s.pendingCatalogETag != s.state.CatalogETag
		if needFollowUp {
			s.workers.Add(1)
		}
		close(call.done)
		s.mu.Unlock()
		s.workers.Done()

		if needFollowUp {
			go func() {
				defer s.workers.Done()
				_, _ = s.SyncCatalogIfNeeded(s.lifecycle, CatalogSyncOptions{Force: true})
			}()
		}
		return models, err
	}
}

func (s *Service) executeCatalogRefresh(ctx context.Context, opts CatalogSyncOptions) ([]CatalogModel, error) {
	s.mu.Lock()
	state := s.state
	closed := s.closed
	s.mu.Unlock()
	if closed || !state.hasCredential() || !state.Acked {
		return nil, errNotConnected
	}
	if s.provider == nil {
		return nil, errStore
	}
	if state.Status == StateRevoked || state.Status == StateExpired || state.Status == StateRejected {
		return nil, errRevoked
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	apiKey, err := decryptSecret(s.dataDir, state.EncryptedAPIKey)
	if err != nil {
		return nil, errStore
	}
	ifNoneMatch := ""
	priceIfNoneMatch := ""
	prevInlinePricing := false
	if !opts.BypassETag && state.CatalogOK && strings.TrimSpace(state.CatalogClientVersion) == strings.TrimSpace(s.clientVersion) {
		ifNoneMatch = strings.TrimSpace(state.CatalogETag)
		priceIfNoneMatch = strings.TrimSpace(state.PriceCatalogETag)
		prevInlinePricing = state.CatalogInlinePricing
	}
	res, err := s.fetchModelsConditional(ctx, apiKey, ifNoneMatch, priceIfNoneMatch, prevInlinePricing)
	if err != nil {
		if errors.Is(err, errRevoked) {
			s.MarkRevoked()
			return nil, errRevoked
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		s.mu.Lock()
		if s.sameCredentialLocked(state) {
			s.noteCatalogFailureLocked()
		}
		s.mu.Unlock()
		return nil, errors.New("读取模型列表失败，请重试")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if res.NotModified {
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.sameCredentialLocked(state) {
			return nil, errors.New("企业连接已改变，请重新读取模型")
		}
		now := s.now()
		s.lastCatalogAttemptAt = now
		s.lastCatalogCheckAt = now
		s.catalogFailures = 0
		s.state.CatalogSyncedAt = now.UTC().Format(time.RFC3339Nano)
		s.state.CatalogClientVersion = s.clientVersion
		if res.ETag != "" {
			s.state.CatalogETag = res.ETag
		}
		if res.PriceETag != "" && !s.state.CatalogInlinePricing {
			s.state.PriceCatalogETag = res.PriceETag
		}
		if s.pendingCatalogETag == s.state.CatalogETag {
			s.pendingCatalogETag = ""
		}
		_ = s.persistState(s.state)
		return nil, nil
	}
	for _, model := range res.Models {
		if len(model.ImageCapabilities) > 0 && string(model.ImageCapabilities) != "null" {
			if _, valid := NormalizeCatalogImageCapability(model.ImageCapabilities); !valid || model.ImageCapabilitiesVersion == "" {
				s.mu.Lock()
				if s.sameCredentialLocked(state) {
					s.noteCatalogFailureLocked()
				}
				s.mu.Unlock()
				return nil, errors.New("读取模型能力失败，请重试")
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sameCredentialLocked(state) {
		return nil, errors.New("企业连接已改变，请重新读取模型")
	}
	accountID := ""
	if state.Account != nil {
		accountID = state.Account.ID.String()
	}
	authorizationID := ""
	if s.state.AssistantDefaultPending {
		authorizationID = s.state.TokenID
	}
	rev, err := applyCatalogWithOptions(s.provider, res.Models, accountID, accountID, authorizationID, res.PreservePrices)
	if err != nil {
		s.noteCatalogFailureLocked()
		return nil, errStore
	}
	s.recordCatalogWriteLocked(rev)
	now := s.now()
	s.lastCatalogAttemptAt = now
	s.lastCatalogCheckAt = now
	s.catalogFailures = 0
	s.state.CatalogOK = true
	s.state.Status = StateConnected
	s.state.LastError = ""
	s.state.AssistantDefaultPending = false
	if s.state.ConnectedAt == "" {
		s.state.ConnectedAt = now.UTC().Format(time.RFC3339Nano)
	}
	s.state.CatalogSyncedAt = now.UTC().Format(time.RFC3339Nano)
	s.state.CatalogClientVersion = s.clientVersion
	s.state.CatalogInlinePricing = res.InlinePricing
	if res.ETag != "" {
		s.state.CatalogETag = res.ETag
	} else {
		s.state.CatalogETag = ""
	}
	if res.InlinePricing {
		s.state.PriceCatalogETag = ""
	} else if res.PriceETag != "" {
		s.state.PriceCatalogETag = res.PriceETag
	} else if !res.PreservePrices {
		s.state.PriceCatalogETag = ""
	}
	if s.pendingCatalogETag != "" && s.pendingCatalogETag == s.state.CatalogETag {
		s.pendingCatalogETag = ""
	}
	_ = s.persistState(s.state)
	return res.Models, nil
}

func (s *Service) sameCredentialLocked(state persistedState) bool {
	if s.closed || s.state.EncryptedAPIKey != state.EncryptedAPIKey || s.state.TokenID != state.TokenID ||
		s.state.ProviderBaseURL != state.ProviderBaseURL || s.state.Status != state.Status {
		return false
	}
	accountID := ""
	if state.Account != nil {
		accountID = state.Account.ID.String()
	}
	currentAccountID := ""
	if s.state.Account != nil {
		currentAccountID = s.state.Account.ID.String()
	}
	return currentAccountID == accountID
}

func (s *Service) verifyRemote() {
	defer func() {
		s.mu.Lock()
		s.startupVerifyPending = false
		s.mu.Unlock()
	}()
	seq := s.currentBalanceSeq()
	cred, err := s.Resolve()
	if err != nil {
		return
	}
	view, status, err := s.remoteConnection(cred.APIKey)
	if s.lifecycle.Err() != nil {
		return
	}
	if err != nil {
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		s.MarkRevoked()
		return
	}
	if status >= 200 && status < 300 {
		s.applyRemoteConnectionViewIfCurrent(seq, view)
		// If remote connection already reports a matching ETag for the same
		// client version and inline pricing, renew freshness without fetching /v1/models.
		if remoteETag := strings.TrimSpace(view.CatalogETag); remoteETag != "" {
			s.mu.Lock()
			matches := remoteETag == s.state.CatalogETag &&
				s.state.CatalogInlinePricing &&
				strings.TrimSpace(s.state.CatalogClientVersion) == strings.TrimSpace(s.clientVersion) &&
				s.state.CatalogOK
			if matches {
				now := s.now()
				s.lastCatalogAttemptAt = now
				s.lastCatalogCheckAt = now
				s.catalogFailures = 0
				s.state.CatalogSyncedAt = now.UTC().Format(time.RFC3339Nano)
				_ = s.persistState(s.state)
			}
			s.mu.Unlock()
			if matches {
				return
			}
		}
		_, _ = s.SyncCatalogIfNeeded(s.lifecycle, CatalogSyncOptions{Force: true})
	}
}
