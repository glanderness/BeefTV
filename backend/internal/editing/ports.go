package editing

import (
	"context"
	"io"
)

// SourceOpener opens authorized bytes for an opaque plan source id.
// Callers resolve workspace ownership; this package never accepts native paths.
type SourceOpener interface {
	Open(ctx context.Context, sourceID string) (io.ReadCloser, error)
}

// SourceMIMEProvider is optionally implemented by a SourceOpener that knows
// the authorized MIME type of an opaque source id.
type SourceMIMEProvider interface {
	OpenWithMIME(ctx context.Context, sourceID string) (io.ReadCloser, string, error)
}

type mimeOpenerFunc func(ctx context.Context, sourceID string) (io.ReadCloser, string, error)

func (f mimeOpenerFunc) Open(ctx context.Context, sourceID string) (io.ReadCloser, error) {
	reader, _, err := f.OpenWithMIME(ctx, sourceID)
	return reader, err
}

func (f mimeOpenerFunc) OpenWithMIME(ctx context.Context, sourceID string) (io.ReadCloser, string, error) {
	return f(ctx, sourceID)
}

// NewMIMEOpener wraps an owner-scoped opener callback as both SourceOpener and SourceMIMEProvider.
func NewMIMEOpener(open func(ctx context.Context, sourceID string) (io.ReadCloser, string, error)) SourceOpener {
	return mimeOpenerFunc(open)
}

// Progress reports native render stages owned by this package. A nil Progress is ignored.
type Progress func(stage string, percent int) error
