package playback

import (
	"log"

	"infinite-canvas/backend/internal/model"
)

func persistResource(store Store, resource *model.Resource, context string) error {
	if store == nil || resource == nil {
		return nil
	}
	var err error
	for attempt := 1; attempt <= PersistAttempts; attempt++ {
		err = store.SaveResource(resource)
		if err == nil {
			return nil
		}
	}
	log.Printf("playback transcode persist failed: resource=%s context=%s attempts=%d error=%v", resource.ID, context, PersistAttempts, err)
	return err
}

func markNone(store Store, resource *model.Resource) {
	if resource == nil || store == nil {
		return
	}
	if resource.PlaybackStatus == model.PlaybackStatusNone {
		return
	}
	previous := resource.PlaybackStatus
	resource.PlaybackStatus = model.PlaybackStatusNone
	if err := persistResource(store, resource, "mark_none"); err != nil {
		resource.PlaybackStatus = previous
	}
}
