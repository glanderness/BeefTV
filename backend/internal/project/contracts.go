package project

import "infinite-canvas/backend/internal/model"

type CreateProjectRequest struct {
	Name              string `json:"name"`
	Type              string `json:"type"`
	AspectRatio       string `json:"aspectRatio"`
	SourceType        string `json:"sourceType"`
	Description       string `json:"description"`
	StylePresetID     string `json:"stylePresetId"`
	StyleProfileJSON  string `json:"styleProfileJson"`
	DefaultImageModel string `json:"defaultImageModel"`
	DefaultVideoModel string `json:"defaultVideoModel"`
}

type UpdateProjectRequest struct {
	Name              string  `json:"name"`
	Type              string  `json:"type"`
	AspectRatio       string  `json:"aspectRatio"`
	SourceType        string  `json:"sourceType"`
	Description       *string `json:"description"`
	CoverResourceID   *string `json:"coverResourceId"`
	StylePresetID     *string `json:"stylePresetId"`
	StyleProfileJSON  *string `json:"styleProfileJson"`
	DefaultImageModel *string `json:"defaultImageModel"`
	DefaultVideoModel *string `json:"defaultVideoModel"`
	Status            string  `json:"status"`
}

type CreateProjectUnitRequest struct {
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	SourceText string `json:"sourceText"`
	Position   int    `json:"position"`
}

type UpdateProjectUnitRequest struct {
	Title      string `json:"title"`
	SourceText string `json:"sourceText"`
	Status     string `json:"status"`
}

type ImportProjectUnitsRequest struct {
	Units []CreateProjectUnitRequest `json:"units"`
}

type ReorderProjectUnitsRequest struct {
	UnitIDs []string `json:"unitIds"`
}

type LinkCanvasUnitRequest struct {
	CanvasID string `json:"canvasId"`
	UnitID   string `json:"unitId"`
	Role     string `json:"role"`
}

type CreateProjectFolderRequest struct {
	Name     string `json:"name"`
	ParentID string `json:"parentId"`
}

// WorkflowSeed is the default production instance prepared by a collaborator.
// Persistence stays in the same project-create transaction.
type WorkflowSeed struct {
	Instance model.WorkflowInstance
	Steps    []model.WorkflowStepInstance
}

// Summary is the local list card. Collaborator counts stay numeric so the
// composition root does not leak asset or task document types into this port.
type Summary struct {
	Project            model.Project `json:"project"`
	CanvasCount        int           `json:"canvasCount"`
	AssetCount         int64         `json:"assetCount"`
	UnitCount          int           `json:"unitCount"`
	CompletedUnitCount int           `json:"completedUnitCount"`
}

type ListPage struct {
	Projects []Summary `json:"projects"`
	Page     int       `json:"page"`
	PageSize int       `json:"pageSize"`
	Total    int64     `json:"total"`
	HasMore  bool      `json:"hasMore"`
}

type Core struct {
	Project model.Project `json:"project"`
}

type UnitSummaries struct {
	Units        []model.ProjectUnit `json:"units"`
	CanvasCounts map[string]int64    `json:"canvasCounts"`
}

type Overview struct {
	Metrics OverviewMetrics `json:"metrics"`
	Units   []OverviewUnit  `json:"units"`
}

type OverviewMetrics struct {
	UnitCount             int64 `json:"unitCount"`
	CompletedUnitCount    int64 `json:"completedUnitCount"`
	TotalWordCount        int64 `json:"totalWordCount"`
	UnitsWithoutText      int64 `json:"unitsWithoutText"`
	UnitsWithoutShots     int64 `json:"unitsWithoutShots"`
	CanvasCount           int64 `json:"canvasCount"`
	AssetCount            int64 `json:"assetCount"`
	ShotCount             int64 `json:"shotCount"`
	PendingCandidateCount int64 `json:"pendingCandidateCount"`
	ReadyStoryboardCount  int64 `json:"readyStoryboardCount"`
	ReadyPrevizCount      int64 `json:"readyPrevizCount"`
	ReadyVideoCount       int64 `json:"readyVideoCount"`
	RenderSucceededCount  int64 `json:"renderSucceededCount"`
	StaleArtifactCount    int64 `json:"staleArtifactCount"`
}

type OverviewUnit struct {
	Unit           model.ProjectUnit `json:"unit"`
	ShotCount      int64             `json:"shotCount"`
	CandidateCount int64             `json:"candidateCount"`
	CanvasCount    int64             `json:"canvasCount"`
}

type CanvasPage struct {
	Canvases        []model.CanvasProject  `json:"canvases"`
	CanvasUnitLinks []model.CanvasUnitLink `json:"canvasUnitLinks"`
	Page            int                    `json:"page"`
	PageSize        int                    `json:"pageSize"`
	Total           int64                  `json:"total"`
	HasMore         bool                   `json:"hasMore"`
}

// Snapshot is the project-owned slice of a workbench read. Asset cards,
// workflow instances and task summaries remain collaborator-owned.
type Snapshot struct {
	Project         model.Project                 `json:"project"`
	Units           []model.ProjectUnit           `json:"units"`
	Canvases        []model.CanvasProject         `json:"canvases"`
	CanvasUnitLinks []model.CanvasUnitLink        `json:"canvasUnitLinks"`
	AssetFolders    []model.ProjectAssetFolder    `json:"assetFolders"`
	Shots           []model.Shot                  `json:"shots"`
	ShotRevisions   []model.ShotRevision          `json:"shotRevisions"`
	ShotArtifacts   []model.ShotArtifact          `json:"shotArtifacts"`
	ShotReferences  []model.ShotAssetReference    `json:"shotReferences"`
	AssetCandidates []model.ProjectAssetCandidate `json:"assetCandidates"`
}
