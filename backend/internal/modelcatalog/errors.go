package modelcatalog

import "infinite-canvas/backend/internal/kernel"

func badAuth(message string) error {
	return kernel.BadAuthRequest(message)
}
