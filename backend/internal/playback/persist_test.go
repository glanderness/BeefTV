package playback

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type failingStore struct {
	failTimes int
	calls     int
	memStore
}

func (s *failingStore) SaveResource(resource *model.Resource) error {
	s.calls++
	if s.calls <= s.failTimes {
		return errors.New("db busy")
	}
	return s.memStore.SaveResource(resource)
}

func TestPersistResourceRetriesThenSucceeds(t *testing.T) {
	store := &failingStore{failTimes: 2}
	if err := persistResource(store, &model.Resource{ID: "r1"}, "test"); err != nil {
		t.Fatal(err)
	}
	if store.calls != PersistAttempts {
		t.Fatalf("calls = %d, want %d", store.calls, PersistAttempts)
	}
}

func TestPersistResourceReturnsAfterExhaustedRetries(t *testing.T) {
	store := &failingStore{failTimes: 10}
	if err := persistResource(store, &model.Resource{ID: "r1"}, "test"); err == nil {
		t.Fatal("expected persist error")
	}
	if store.calls != PersistAttempts {
		t.Fatalf("calls = %d, want %d", store.calls, PersistAttempts)
	}
}
