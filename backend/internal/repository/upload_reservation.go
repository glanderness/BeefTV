package repository

import (
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func resourceUploadIdentity(resource *model.Resource) string {
	if resource == nil {
		return ""
	}
	if resource.UploadKey != nil {
		if key := strings.TrimSpace(*resource.UploadKey); key != "" {
			return key
		}
	}
	return strings.TrimSpace(resource.ID)
}

func saveResourceSettlingReservation(tx *gorm.DB, resource *model.Resource) error {
	if resource == nil {
		return errors.New("resource is nil")
	}
	if err := tx.Save(resource).Error; err != nil {
		return err
	}
	identity := resourceUploadIdentity(resource)
	if identity == "" {
		return nil
	}
	switch resource.Status {
	case model.ResourceStatusReady:
		return clearUploadReservationTx(tx, resource.UserID, identity)
	case model.ResourceStatusFailed:
		return releaseIdentifiedDailyUploadTx(tx, resource.UserID, "", identity, 0)
	default:
		return nil
	}
}

func settleDeletedResourceReservation(tx *gorm.DB, resource *model.Resource) error {
	identity := resourceUploadIdentity(resource)
	if identity == "" || resource == nil {
		return nil
	}
	switch resource.Status {
	case model.ResourceStatusPending, model.ResourceStatusFailed:
		return releaseIdentifiedDailyUploadTx(tx, resource.UserID, "", identity, 0)
	default:
		// READY and any other consumed status drop the witness without refunding
		// daily bytes. A later orphan scan must not treat the deleted row as an
		// unused reservation.
		return clearUploadReservationTx(tx, resource.UserID, identity)
	}
}

func reservationTableMissing(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table") && strings.Contains(message, "user_upload_reservations")
}

func clearUploadReservationTx(tx *gorm.DB, userID string, identity string) error {
	identity = strings.TrimSpace(identity)
	if strings.TrimSpace(userID) == "" || identity == "" {
		return nil
	}
	err := tx.Where("user_id = ? AND identity = ?", userID, identity).Delete(&model.UserUploadReservation{}).Error
	if reservationTableMissing(err) {
		return nil
	}
	return err
}

func releaseIdentifiedDailyUploadTx(tx *gorm.DB, userID string, day string, identity string, size int64) error {
	identity = strings.TrimSpace(identity)
	if identity != "" {
		var held model.UserUploadReservation
		err := tx.Where("user_id = ? AND identity = ?", userID, identity).First(&held).Error
		if errors.Is(err, gorm.ErrRecordNotFound) || reservationTableMissing(err) {
			return nil
		}
		if err != nil {
			return err
		}
		// Recovery may see both an orphan reservation and the session metadata.
		// The durable identity owns the amount and day; release it only once.
		day, size = held.Day, held.Size
	}
	id := userID + ":" + day
	if err := tx.Model(&model.UserDailyUploadUsage{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"bytes":      gorm.Expr("CASE WHEN bytes >= ? THEN bytes - ? ELSE 0 END", size, size),
			"updated_at": time.Now(),
		}).Error; err != nil {
		return err
	}
	if identity == "" {
		return nil
	}
	return tx.Where("user_id = ? AND identity = ?", userID, identity).Delete(&model.UserUploadReservation{}).Error
}

func settleDeletedResources(tx *gorm.DB, resources []model.Resource) error {
	for index := range resources {
		if err := settleDeletedResourceReservation(tx, &resources[index]); err != nil {
			return err
		}
	}
	return nil
}
