package app

import (
	"infinite-canvas/backend/internal/mediaattempt"
)

func definiteImageInputRejection(err error) bool {
	return mediaattempt.DefiniteImageInputRejection(err)
}
