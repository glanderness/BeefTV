package generation

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"
)

// ResourceInfo is the executor view of an owned workspace asset.
// Authorization stays in the app adapter that implements ResourcePort.
type ResourceInfo struct {
	UserID     string
	ID         string
	Status     string
	Kind       string
	MimeType   string
	Provider   string
	Size       int64
	Width      int
	Height     int
	DurationMs int64
}

func (r ResourceInfo) UsesObjectStorage() bool {
	provider := strings.ToLower(strings.TrimSpace(r.Provider))
	return provider != "" && provider != "local"
}

func (r ResourceInfo) LooksLikeImage(media *Media) bool {
	if strings.EqualFold(r.Kind, "image") || strings.HasPrefix(strings.ToLower(r.MimeType), "image/") {
		return true
	}
	if media == nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(firstNonEmpty(media.MimeType, media.Type)), "image/")
}

type ResourcePort interface {
	Lookup(userID, resourceID string) (ResourceInfo, error)
	Open(userID, resourceID string) (ResourceInfo, io.ReadCloser, error)
	PublicURL(info ResourceInfo, expiresAt time.Time) (string, error)
	HTTPSPublicURL(info ResourceInfo, expiresAt time.Time) (string, error)
	LocalMode() bool
}

type LimitsPort interface {
	GeneratedFileBytes(ctx context.Context) (int64, error)
	ResourceUploadBytes(ctx context.Context) (int64, error)
	CircuitOpen(ctx context.Context, channelID string) (bool, error)
	AcquireChannelSlot(ctx context.Context, channelID, slotID string, timeout time.Duration) (release func(), limit int, err error)
	RecordChannelResult(ctx context.Context, channelID string, failure bool) error
}

type TransportObservation struct {
	Request               *http.Request
	StartedAt             time.Time
	StatusCode            int
	Body                  []byte
	Err                   error
	ResponseLimitBytes    int64
	Dispatched            bool
	HTTPStatus            int
	DeclaredResponseBytes int64
	ReceivedBytes         int64
	RequestID             string
	Outcome               string
}

type ReceiptPort interface {
	Observe(observation TransportObservation)
	NotifyPoll(ctx context.Context, event string, err error)
	SyncProgress(taskID string, body []byte)
}

type ImageSubmissionPort interface {
	Intercept(req *http.Request) (handled bool, data []byte, mimeType string, err error)
}

// WorkflowPort is the typed seam for RunningHub / cloud workflow execution.
// The workflow slice owns the implementation; this package only dispatches.
type WorkflowPort interface {
	Execute(ctx context.Context, input Input) (map[string]interface{}, error)
}

type CallMeta struct {
	UserID            string
	TaskID            string
	TraceID           string
	RequestID         string
	Capability        string
	Operation         string
	ChannelID         string
	Model             string
	VideoSeconds      int
	RequestKind       string
	ProviderRequestID string
	ConcurrencyLimit  int
}

type Runtime struct {
	Resources ResourcePort
	Limits    LimitsPort
	Receipts  ReceiptPort
	Images    ImageSubmissionPort
	Workflow  WorkflowPort
	Call      CallMeta
}
