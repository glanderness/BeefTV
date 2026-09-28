package localapp

import (
	"context"
	"mime/multipart"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// These ports intentionally expose one cohesive local capability each. During
// the strangler migration app.Service implements them; later stages replace
// the adapters independently without changing the composition root.
type WorkspacePort interface {
	WorkspaceOwner(string) (*model.User, error)
}

type ProjectPort interface {
	ListProjects(string) ([]app.ProjectSummary, error)
}

type AssetPort interface {
	Resources(string, int) ([]model.Resource, error)
	UploadLocalResource(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error)
}

type TaskPort interface {
	TasksWithOptions(string, localtask.ListOptions) ([]localtask.Summary, error)
}

type GenerationPort interface {
	CreateTask(string, localtask.CreateRequest) (*model.Task, error)
}

type ProviderConfigPort interface {
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

type Lifecycle interface {
	StartWorker()
	StopWorker(context.Context) error
	Close() error
}
