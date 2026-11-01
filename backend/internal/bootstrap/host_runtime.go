package bootstrap

import (
	"context"
	"infinite-canvas/backend/internal/depthcapture"
	"net/http"
)

// HostRuntime is the shell contract shared by the official local runtime and
// optional account hosts. Account lifecycle stays outside the local kernel.
type HostRuntime interface {
	Handler() http.Handler
	Start() error
	Ready() bool
	BaseURL() string
	LaunchToken() string
	UIBootstrapToken() string
	Errors() <-chan error
	Close(context.Context) error
	DepthComponents() *depthcapture.Service
	PrepareStorageMigration(context.Context) (func(), error)
	CopyOwnedResourceTo(string, string) error
	WriteOwnedArchiveTo(context.Context, []OwnedArchiveEntry, string) error
}
