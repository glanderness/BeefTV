package assets

import (
	"io"

	"infinite-canvas/backend/internal/model"
)

// MaxInlineMediaBytes is the single source of truth bounding inline data URLs
// and in-memory media fallbacks so large 1-2 GiB streaming deliveries never
// spill into Go heap memory.
const MaxInlineMediaBytes int64 = 256 << 20

type ResourceStream struct {
	Resource      *model.Resource
	Body          io.ReadCloser
	StatusCode    int
	ContentLength int64
	ContentRange  string
	AcceptRanges  string
}

type ResourceDeliveryOptions struct {
	ForceDirect bool
	ForceProxy  bool
}

type ResourceDelivery struct {
	Resource    *model.Resource
	Stream      *ResourceStream
	RedirectURL string
}
