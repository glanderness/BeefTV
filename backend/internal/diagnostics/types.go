package diagnostics

import "time"

const (
	SchemaVersion    = 1
	RedactionVersion = 1
	maxWindow        = 24 * time.Hour
	maxClientEvents  = 500
	maxBundleBytes   = 10 << 20
	maxDescription   = 1000
	maxEventText     = 4000
)

type ClientEvent struct {
	ID         string `json:"id"`
	Timestamp  string `json:"timestamp"`
	Level      string `json:"level"`
	Category   string `json:"category"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message"`
	Route      string `json:"route,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
	TraceID    string `json:"traceId,omitempty"`
	TaskID     string `json:"taskId,omitempty"`
	ProjectID  string `json:"projectId,omitempty"`
	CanvasID   string `json:"canvasId,omitempty"`
	Stack      string `json:"stack,omitempty"`
}

type Runtime struct {
	AppVersion  string `json:"appVersion,omitempty"`
	BuildCommit string `json:"buildCommit,omitempty"`
	Browser     string `json:"browser,omitempty"`
	OS          string `json:"os,omitempty"`
	Timezone    string `json:"timezone,omitempty"`
}

type ExportRequest struct {
	From         string        `json:"from"`
	To           string        `json:"to"`
	TaskID       string        `json:"taskId,omitempty"`
	ProjectID    string        `json:"projectId,omitempty"`
	Description  string        `json:"description,omitempty"`
	Runtime      Runtime       `json:"runtime"`
	ClientEvents []ClientEvent `json:"clientEvents"`
}

type Preview struct {
	ClientEventLimit int   `json:"clientEventLimit"`
	TaskCount        int   `json:"taskCount"`
	TaskLogCount     int   `json:"taskLogCount"`
	APICallCount     int   `json:"apiCallCount"`
	EstimatedBytes   int64 `json:"estimatedBytes"`
	WillTruncate     bool  `json:"willTruncate"`
}

type Bundle struct {
	BundleID string
	FileName string
	Data     []byte
}

type timeWindow struct {
	From time.Time
	To   time.Time
}

type collection struct {
	Window       timeWindow
	Description  string
	TaskID       string
	ProjectID    string
	Runtime      runtimeRecord
	ClientEvents []clientEventRecord
	Tasks        []taskRecord
	TaskLogs     []taskLogRecord
	APICalls     []apiCallRecord
	Truncated    bool
}

type runtimeRecord struct {
	AppVersion  string `json:"appVersion,omitempty"`
	BuildCommit string `json:"buildCommit,omitempty"`
	Browser     string `json:"browser,omitempty"`
	OS          string `json:"os,omitempty"`
	Timezone    string `json:"timezone,omitempty"`
}

type clientEventRecord struct {
	ID         string `json:"id,omitempty"`
	Timestamp  string `json:"timestamp,omitempty"`
	Level      string `json:"level,omitempty"`
	Category   string `json:"category,omitempty"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
	Route      string `json:"route,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	RequestID  string `json:"requestId,omitempty"`
	TraceID    string `json:"traceId,omitempty"`
	TaskID     string `json:"taskId,omitempty"`
	ProjectID  string `json:"projectId,omitempty"`
	CanvasID   string `json:"canvasId,omitempty"`
	Stack      string `json:"stack,omitempty"`
}

type taskRecord struct {
	ID                string     `json:"id"`
	TraceID           string     `json:"traceId,omitempty"`
	RequestID         string     `json:"requestId,omitempty"`
	ProjectID         string     `json:"projectId,omitempty"`
	Type              string     `json:"type,omitempty"`
	Status            string     `json:"status,omitempty"`
	Stage             string     `json:"stage,omitempty"`
	Progress          int        `json:"progress,omitempty"`
	Operation         string     `json:"operation,omitempty"`
	Provider          string     `json:"provider,omitempty"`
	Model             string     `json:"model,omitempty"`
	LogicalModelID    string     `json:"logicalModelId,omitempty"`
	ProviderRequestID string     `json:"providerRequestId,omitempty"`
	Error             string     `json:"error,omitempty"`
	Attempts          int        `json:"attempts,omitempty"`
	StartedAt         *time.Time `json:"startedAt,omitempty"`
	CompletedAt       *time.Time `json:"completedAt,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

type taskLogRecord struct {
	ID        string    `json:"id"`
	TaskID    string    `json:"taskId,omitempty"`
	TraceID   string    `json:"traceId,omitempty"`
	RequestID string    `json:"requestId,omitempty"`
	Level     string    `json:"level,omitempty"`
	Message   string    `json:"message,omitempty"`
	Payload   string    `json:"payload,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type apiCallRecord struct {
	ID                string    `json:"id"`
	TraceID           string    `json:"traceId,omitempty"`
	RequestID         string    `json:"requestId,omitempty"`
	ChannelID         string    `json:"channelId,omitempty"`
	TaskID            string    `json:"taskId,omitempty"`
	Source            string    `json:"source,omitempty"`
	Capability        string    `json:"capability,omitempty"`
	Operation         string    `json:"operation,omitempty"`
	RequestKind       string    `json:"requestKind,omitempty"`
	APIFormat         string    `json:"apiFormat,omitempty"`
	Method            string    `json:"method,omitempty"`
	Path              string    `json:"path,omitempty"`
	Model             string    `json:"model,omitempty"`
	Status            string    `json:"status,omitempty"`
	StatusCode        int       `json:"statusCode,omitempty"`
	DurationMs        int64     `json:"durationMs,omitempty"`
	PollCount         int       `json:"pollCount,omitempty"`
	ProviderStatus    string    `json:"providerStatus,omitempty"`
	ProviderRequestID string    `json:"providerRequestId,omitempty"`
	ErrorCode         string    `json:"errorCode,omitempty"`
	Error             string    `json:"error,omitempty"`
	StartedAt         time.Time `json:"startedAt"`
	CreatedAt         time.Time `json:"createdAt"`
}

type manifest struct {
	SchemaVersion    int       `json:"schemaVersion"`
	BundleID         string    `json:"bundleId"`
	GeneratedAt      time.Time `json:"generatedAt"`
	AppVersion       string    `json:"appVersion,omitempty"`
	BuildCommit      string    `json:"buildCommit,omitempty"`
	TimeRange        timeRange `json:"timeRange"`
	TaskID           string    `json:"taskId,omitempty"`
	ProjectID        string    `json:"projectId,omitempty"`
	Description      string    `json:"description,omitempty"`
	RedactionVersion int       `json:"redactionVersion"`
	Truncated        bool      `json:"truncated,omitempty"`
	Counts           counts    `json:"counts"`
}

type timeRange struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type counts struct {
	ClientEvents int `json:"clientEvents"`
	Tasks        int `json:"tasks"`
	TaskLogs     int `json:"taskLogs"`
	APICalls     int `json:"upstreamCalls"`
}
