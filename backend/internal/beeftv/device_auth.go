package beeftv

import (
	"context"
	"errors"
	"strings"
	"time"
)

const ackRetryLimit = 5

func (s *Service) pollLoop(ctx context.Context, deviceCode string, interval time.Duration, expiresAt time.Time) {
	if interval < time.Second {
		interval = 5 * time.Second
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if !expiresAt.IsZero() && s.now().After(expiresAt) {
			s.setError(StateExpired, "授权已过期，请重新连接")
			return
		}
		token, code, err := s.pollToken(deviceCode)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.updatePollMessage(deviceCode, "连接中断，正在重试")
			if !s.pause(ctx, interval) {
				return
			}
			continue
		}
		switch code {
		case "", "success":
			if strings.TrimSpace(token.APIKey) == "" {
				if !s.pause(ctx, interval) {
					return
				}
				continue
			}
			_ = s.acceptToken(ctx, deviceCode, token)
			return
		case "authorization_pending":
			s.updatePollMessage(deviceCode, "")
			if !s.pause(ctx, interval) {
				return
			}
		case "slow_down":
			interval += 5 * time.Second
			if !s.pause(ctx, interval) {
				return
			}
		case "expired_token", "expired":
			s.setError(StateExpired, "授权已过期，请重新连接")
			return
		case "access_denied", "denied", "rejected":
			s.setError(StateRejected, "授权被拒绝")
			return
		default:
			s.updatePollMessage(deviceCode, "授权状态读取失败，正在重试")
			if !s.pause(ctx, interval) {
				return
			}
		}
	}
}

func (s *Service) updatePollMessage(deviceCode, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed && s.state.Status == StatePending && s.state.Device != nil && s.state.Device.DeviceCode == deviceCode {
		s.state.LastError = message
	}
}

func (s *Service) acceptToken(ctx context.Context, deviceCode string, token tokenSuccess) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	origin := s.Origin()
	accountID, tokenID, err := validateTokenSuccess(origin, token)
	if err != nil {
		s.setError(StateRejected, err.Error())
		return err
	}
	encrypted, err := encryptSecret(s.dataDir, token.APIKey)
	if err != nil {
		s.setError(StateStoreError, "保存连接失败，请重试")
		return errStore
	}
	s.mu.Lock()
	previousAccount := ""
	if s.state.Account != nil {
		previousAccount = s.state.Account.ID.String()
	}
	previousEncrypted := s.state.EncryptedAPIKey
	account := token.Account
	account.ID = wireID(accountID)
	if s.state.Device == nil {
		s.state.Device = &persistedDevice{}
	}
	s.state.Device.DeviceCode = deviceCode
	s.state.EncryptedAPIKey = encrypted
	s.state.ProviderBaseURL = ProviderBaseURL(origin)
	s.state.Market = "enterprise"
	s.state.Group = "enterprise"
	s.state.Account = &account
	s.state.KeyName = token.KeyName
	s.state.TokenID = tokenID
	s.state.Acked = false
	s.state.CatalogOK = false
	s.state.CatalogETag = ""
	s.state.CatalogSyncedAt = ""
	s.state.CatalogClientVersion = ""
	s.pendingCatalogETag = ""
	s.lastCatalogCheckAt = time.Time{}
	s.lastCatalogAttemptAt = time.Time{}
	s.catalogFailures = 0
	s.state.AssistantDefaultPending = true
	s.state.Status = StatePending
	s.balanceSeq++
	s.state.QuotaPerUnit = token.QuotaPerUnit
	s.state.Balance, s.state.BalanceCNY = normalizeRemoteBalance(token.BalanceCNY, token.Quota, BalanceUnknown, "")
	s.state.LastError = ""
	if err := s.persistState(s.state); err != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		s.mu.Unlock()
		return errStore
	}
	s.mu.Unlock()
	if previousEncrypted != "" && previousAccount != "" && previousAccount != accountID {
		if oldKey, decryptErr := decryptSecret(s.dataDir, previousEncrypted); decryptErr == nil && oldKey != "" && oldKey != token.APIKey {
			_ = s.revokeRemote(oldKey)
		}
	}
	return s.finalizeSavedCredential(ctx, previousAccount)
}

func (s *Service) finalizeSavedCredential(ctx context.Context, previousAccountID string) error {
	if s.lifecycle.Err() != nil {
		return s.lifecycle.Err()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	s.mu.Lock()
	state := s.state
	deviceCode := ""
	if state.Device != nil {
		deviceCode = state.Device.DeviceCode
	}
	s.mu.Unlock()
	if !state.hasCredential() {
		return errNotConnected
	}
	if !state.Acked {
		if strings.TrimSpace(deviceCode) == "" {
			s.markDoomedCredential(StateExpired, "授权已过期，请重新连接")
			return errAckExpired
		}
		s.mu.Lock()
		s.state.Status = StatePending
		s.state.LastError = "正在完成连接确认"
		s.mu.Unlock()
		if err := s.acknowledgeWithRetry(deviceCode); err != nil {
			if s.lifecycle.Err() != nil {
				return s.lifecycle.Err()
			}
			s.noteAckFailure(err)
			return err
		}
		s.mu.Lock()
		previousDevice := s.state.Device
		s.state.Acked = true
		s.state.LastError = ""
		s.state.Device = nil
		if err := s.persistState(s.state); err != nil {
			s.state.Acked = false
			s.state.Device = previousDevice
			s.state.Status = StateStoreError
			s.state.LastError = "保存连接失败，请重试"
			s.mu.Unlock()
			return errStore
		}
		s.mu.Unlock()
	}
	_, err := s.refreshCatalog(ctx, catalogSyncRequest{
		CatalogSyncOptions:  CatalogSyncOptions{Force: true, BypassETag: true},
		previousAccountID:   previousAccountID,
		persistFailureState: true,
	})
	s.mu.Lock()
	canSync := s.canSyncCatalogStateLocked()
	s.mu.Unlock()
	if canSync {
		s.startCatalogSyncLoop()
	}
	return err
}

func (s *Service) acknowledgeWithRetry(deviceCode string) error {
	var last error
	for attempt := 0; attempt < ackRetryLimit; attempt++ {
		if s.lifecycle.Err() != nil {
			return s.lifecycle.Err()
		}
		if attempt > 0 {
			if !s.pause(s.lifecycle, time.Second) {
				return s.lifecycle.Err()
			}
		}
		last = s.acknowledge(deviceCode)
		if last == nil || isPermanentAck(last) {
			return last
		}
	}
	if last == nil {
		return errAckTransient
	}
	return last
}

func (s *Service) noteAckFailure(err error) {
	switch {
	case errors.Is(err, errAckExpired):
		s.markDoomedCredential(StateExpired, "授权已过期，请重新连接")
	case errors.Is(err, errAckRejected):
		s.markDoomedCredential(StateRejected, "授权被拒绝")
	default:
		s.mu.Lock()
		defer s.mu.Unlock()
		s.state.Status = StateConnectionError
		s.state.Acked = false
		s.state.CatalogOK = false
		s.state.LastError = "连接确认失败，请重试"
		if persistErr := s.persistState(s.state); persistErr != nil {
			s.state.Status = StateStoreError
			s.state.LastError = "保存连接失败，请重试"
		}
	}
}

func (s *Service) markDoomedCredential(status, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Status = status
	s.state.LastError = message
	s.state.EncryptedAPIKey = ""
	s.state.Acked = false
	s.state.CatalogOK = false
	s.state.Device = nil
	s.state.TokenID = ""
	s.state.Account = nil
	if persistErr := s.persistState(s.state); persistErr != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
	}
}
