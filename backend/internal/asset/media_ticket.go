package asset

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

const (
	defaultMediaTicketTTL  = 20 * time.Minute
	maxMediaTicketLifetime = 6 * time.Hour
	maxMediaTickets        = 2048
)

// MediaTicket authorizes a single process-ephemeral, loopback-only GET/HEAD
// stream of one owned local resource variant. It never replaces X-Desktop-Token.
type MediaTicket struct {
	UserID     string
	ResourceID string
	Variant    string
	FileName   string
	MimeType   string
	IssuedAt   time.Time
	ExpiresAt  time.Time
}

type MediaTicketStore struct {
	mu      sync.RWMutex
	tickets map[string]MediaTicket
	now     func() time.Time
	ttl     time.Duration
}

func NewMediaTicketStore() *MediaTicketStore {
	return &MediaTicketStore{
		tickets: map[string]MediaTicket{},
		now:     time.Now,
		ttl:     defaultMediaTicketTTL,
	}
}

func (s *MediaTicketStore) Issue(userID, resourceID, variant, fileName, mimeType string) (string, time.Time, error) {
	if s == nil {
		return "", time.Time{}, ResourceMissing()
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(raw)
	now := s.now()
	expiresAt := now.Add(s.ttl)
	entry := MediaTicket{
		UserID:     strings.TrimSpace(userID),
		ResourceID: strings.TrimSpace(resourceID),
		Variant:    normalizeMediaTicketVariant(variant),
		FileName:   strings.TrimSpace(fileName),
		MimeType:   strings.TrimSpace(mimeType),
		IssuedAt:   now,
		ExpiresAt:  expiresAt,
	}

	s.mu.Lock()
	if s.tickets == nil {
		s.tickets = map[string]MediaTicket{}
	}
	if len(s.tickets) >= maxMediaTickets {
		s.sweepLocked(now)
	}
	if len(s.tickets) >= maxMediaTickets {
		// Evict earliest-expiring entry when full.
		var oldestKey string
		var oldestExp time.Time
		for key, item := range s.tickets {
			if oldestKey == "" || item.ExpiresAt.Before(oldestExp) {
				oldestKey = key
				oldestExp = item.ExpiresAt
			}
		}
		if oldestKey != "" {
			delete(s.tickets, oldestKey)
		}
	}
	s.tickets[token] = entry
	s.mu.Unlock()
	return token, expiresAt, nil
}

func (s *MediaTicketStore) Lookup(token string) (MediaTicket, bool) {
	if s == nil {
		return MediaTicket{}, false
	}
	token = strings.TrimSpace(token)
	if len(token) != 64 {
		return MediaTicket{}, false
	}
	now := s.now()
	s.mu.RLock()
	entry, ok := s.tickets[token]
	s.mu.RUnlock()
	if !ok {
		return MediaTicket{}, false
	}
	if !now.Before(entry.ExpiresAt) {
		s.mu.Lock()
		if current, exists := s.tickets[token]; exists && !now.Before(current.ExpiresAt) {
			delete(s.tickets, token)
		}
		s.mu.Unlock()
		return MediaTicket{}, false
	}
	// Sliding TTL renewal while active playback/seeking continues, bounded by
	// maxMediaTicketLifetime so idle tickets still expire cleanly.
	if s.ttl > 0 && entry.ExpiresAt.Sub(now) <= s.ttl/2 {
		hardCap := entry.IssuedAt.Add(maxMediaTicketLifetime)
		if entry.IssuedAt.IsZero() {
			hardCap = now.Add(s.ttl)
		}
		renewed := now.Add(s.ttl)
		if renewed.After(hardCap) {
			renewed = hardCap
		}
		if renewed.After(entry.ExpiresAt) {
			s.mu.Lock()
			if current, exists := s.tickets[token]; exists && now.Before(current.ExpiresAt) && renewed.After(current.ExpiresAt) {
				current.ExpiresAt = renewed
				s.tickets[token] = current
				entry = current
			}
			s.mu.Unlock()
		}
	}
	return entry, true
}

func (s *MediaTicketStore) sweepLocked(now time.Time) {
	for key, item := range s.tickets {
		if !now.Before(item.ExpiresAt) {
			delete(s.tickets, key)
		}
	}
}

func normalizeMediaTicketVariant(variant string) string {
	if strings.EqualFold(strings.TrimSpace(variant), "playback") {
		return "playback"
	}
	return "original"
}
