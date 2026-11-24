package protocol

import "fmt"

type UnavailableError struct {
	Protocol string
	Reason   string
}

func (e UnavailableError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("protocol %s is unavailable", e.Protocol)
	}
	return fmt.Sprintf("protocol %s is unavailable: %s", e.Protocol, e.Reason)
}

// ValidationError carries an explicit user-facing validation failure authored
// in a declarative plugin manifest.
type ValidationError struct {
	Message string
}

func (e ValidationError) Error() string {
	return e.Message
}

func unavailable(metadata Metadata) error {
	return UnavailableError{Protocol: metadata.ID, Reason: metadata.UnavailableReason}
}
