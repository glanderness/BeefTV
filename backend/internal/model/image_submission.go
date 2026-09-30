package model

import "time"

// Persistence contract copied from product recovery; this migration experiment
// does not install or run the image recovery worker.
type ImageSubmission struct {
	AttemptID        string    `gorm:"primaryKey;size:36" json:"-"`
	TaskID           string    `gorm:"size:36;index" json:"-"`
	UserID           string    `gorm:"size:36;index" json:"-"`
	RequestCipher    string    `gorm:"type:text" json:"-"`
	SendCount        int       `json:"-"`
	ResponseAccepted bool      `json:"-"`
	CreatedAt        time.Time `json:"-"`
}
