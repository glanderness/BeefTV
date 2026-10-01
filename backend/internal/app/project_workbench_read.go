package app

import (
	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"

	"golang.org/x/sync/errgroup"
)

type ProjectUnitWorkspace struct {
	Unit            model.ProjectUnit             `json:"unit"`
	Workflows       []ProjectWorkflowDetail       `json:"workflows"`
	Shots           []model.Shot                  `json:"shots"`
	ShotRevisions   []model.ShotRevision          `json:"shotRevisions"`
	ShotArtifacts   []model.ShotArtifact          `json:"shotArtifacts"`
	ShotReferences  []ProjectShotAssetReference   `json:"shotReferences"`
	AssetCandidates []model.ProjectAssetCandidate `json:"assetCandidates"`
	Assets          []ProjectAssetSummary         `json:"assets"`
	Tasks           []TaskSummary                 `json:"tasks"`
}

// ProjectShotAssetReference keeps the immutable visual version selected by the
// shot while also exposing the asset's current card configuration (notably its
// voice binding) for generation-time prompt assembly.
type ProjectShotAssetReference struct {
	model.ShotAssetReference
	Asset             ProjectAssetSummary              `json:"asset"`
	ReferencedVersion ProjectShotAssetReferenceVersion `json:"referencedVersion"`
}

type ProjectShotAssetReferenceVersion struct {
	ID              string                           `json:"id"`
	AssetID         string                           `json:"assetId"`
	Version         int                              `json:"version"`
	Representations []CharacterRepresentationSummary `json:"representations"`
}

type ProjectAssetCandidatePage struct {
	Candidates []model.ProjectAssetCandidate `json:"candidates"`
	Page       int                           `json:"page"`
	PageSize   int                           `json:"pageSize"`
	Total      int64                         `json:"total"`
	HasMore    bool                          `json:"hasMore"`
}

type ProjectAssetPage struct {
	Assets         []ProjectAssetSummary `json:"assets"`
	CategoryCounts map[string]int64      `json:"categoryCounts"`
	FolderCounts   map[string]int64      `json:"folderCounts"`
	Page           int                   `json:"page"`
	PageSize       int                   `json:"pageSize"`
	Total          int64                 `json:"total"`
	HasMore        bool                  `json:"hasMore"`
}

func (s *Service) ProjectCore(userID string, projectID string) (ProjectCore, error) {
	project, err := s.projectDomain().Owned(userID, projectID)
	if err != nil {
		return ProjectCore{}, err
	}
	if s.reconcileCharacterTurnaroundTasks(userID, project.ID) {
		return s.projectDomain().ProjectCore(userID, projectID)
	}
	return ProjectCore{Project: *project}, nil
}

func (s *Service) ProjectUnitSummaries(userID string, projectID string) (ProjectUnitSummaries, error) {
	return s.projectDomain().ProjectUnitSummaries(userID, projectID)
}

func (s *Service) ProjectOverview(userID string, projectID string) (ProjectOverview, error) {
	return s.projectDomain().ProjectOverview(userID, projectID)
}

func (s *Service) ProjectUnitWorkspace(userID string, projectID string, unitID string) (ProjectUnitWorkspace, error) {
	if _, err := s.projectDomain().Owned(userID, projectID); err != nil {
		return ProjectUnitWorkspace{}, err
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return ProjectUnitWorkspace{}, err
	}
	result := ProjectUnitWorkspace{Unit: *unit}
	var projectTasks []TaskSummary
	var shotReferences []model.ShotAssetReference
	var group errgroup.Group
	group.Go(func() error {
		var err error
		result.Shots, err = s.repo.ProjectUnitShots(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		result.ShotRevisions, err = s.repo.ProjectUnitShotRevisions(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		result.ShotArtifacts, err = s.repo.ProjectUnitShotArtifacts(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		shotReferences, err = s.repo.ProjectUnitShotAssetReferences(projectID, unitID)
		return err
	})
	group.Go(func() error {
		var err error
		result.AssetCandidates, err = s.repo.ProjectUnitAssetCandidates(projectID, unitID)
		return err
	})
	group.Go(func() error {
		assets, err := s.repo.ProjectUnitAssets(userID, projectID, unitID)
		if err != nil {
			return err
		}
		result.Assets = make([]ProjectAssetSummary, len(assets))
		var summaries errgroup.Group
		summaries.SetLimit(8)
		for index := range assets {
			index := index
			summaries.Go(func() error {
				summary, summaryErr := s.projectAssetSummary(userID, projectID, &assets[index])
				if summaryErr == nil {
					result.Assets[index] = summary
				}
				return summaryErr
			})
		}
		return summaries.Wait()
	})
	group.Go(func() error {
		instances, err := s.repo.ProjectWorkflowInstancesForUnit(projectID, unitID)
		if err != nil {
			return err
		}
		result.Workflows = make([]ProjectWorkflowDetail, 0, len(instances))
		for _, instance := range instances {
			steps, stepsErr := s.repo.WorkflowSteps(instance.ID)
			if stepsErr != nil {
				return stepsErr
			}
			result.Workflows = append(result.Workflows, ProjectWorkflowDetail{Instance: instance, Steps: steps})
		}
		return nil
	})
	group.Go(func() error {
		recent, err := s.TasksWithOptions(userID, TaskListOptions{Limit: 100, ProjectID: projectID})
		if err != nil {
			return err
		}
		active, err := s.TasksWithOptions(userID, TaskListOptions{Limit: 100, ProjectID: projectID, ActiveOnly: true})
		if err != nil {
			return err
		}
		seen := make(map[string]struct{}, len(recent)+len(active))
		projectTasks = make([]TaskSummary, 0, len(recent)+len(active))
		for _, task := range append(active, recent...) {
			if _, exists := seen[task.ID]; exists {
				continue
			}
			seen[task.ID] = struct{}{}
			projectTasks = append(projectTasks, task)
		}
		return nil
	})
	if err := group.Wait(); err != nil {
		return ProjectUnitWorkspace{}, err
	}
	assetByID := make(map[string]ProjectAssetSummary, len(result.Assets))
	for _, asset := range result.Assets {
		assetByID[asset.ID] = asset
	}
	versionIDs := make([]string, 0, len(shotReferences))
	for _, reference := range shotReferences {
		versionIDs = append(versionIDs, reference.AssetVersionID)
	}
	versions, err := s.repo.ProjectAssetVersionsByIDs(projectID, versionIDs)
	if err != nil {
		return ProjectUnitWorkspace{}, err
	}
	storedRepresentations, err := s.repo.AssetRepresentationsByVersionIDs(versionIDs)
	if err != nil {
		return ProjectUnitWorkspace{}, err
	}
	versionByID := make(map[string]model.AssetVersion, len(versions))
	for _, version := range versions {
		versionByID[version.ID] = version
	}
	representationsByVersionID := make(map[string][]CharacterRepresentationSummary, len(versionIDs))
	for _, representation := range storedRepresentations {
		representationsByVersionID[representation.AssetVersionID] = append(representationsByVersionID[representation.AssetVersionID], CharacterRepresentationSummary{
			ID: representation.ID, ResourceID: representation.ResourceID, MediaType: representation.MediaType, Role: representation.Role,
		})
	}
	result.ShotReferences = make([]ProjectShotAssetReference, 0, len(shotReferences))
	for _, reference := range shotReferences {
		version, exists := versionByID[reference.AssetVersionID]
		if !exists {
			return ProjectUnitWorkspace{}, BadAuthRequest("镜头引用的资产版本不可用")
		}
		asset, exists := assetByID[version.AssetID]
		if !exists {
			return ProjectUnitWorkspace{}, BadAuthRequest("镜头引用的项目资产不可用")
		}
		representations := representationsByVersionID[version.ID]
		if representations == nil {
			representations = []CharacterRepresentationSummary{}
		}
		result.ShotReferences = append(result.ShotReferences, ProjectShotAssetReference{
			ShotAssetReference: reference,
			Asset:              asset,
			ReferencedVersion: ProjectShotAssetReferenceVersion{
				ID: version.ID, AssetID: version.AssetID, Version: version.Version, Representations: representations,
			},
		})
	}
	shotIDs := make(map[string]struct{}, len(result.Shots))
	for _, shot := range result.Shots {
		shotIDs[shot.ID] = struct{}{}
	}
	result.Tasks = make([]TaskSummary, 0, len(projectTasks))
	for _, task := range projectTasks {
		context := task.ClientContext
		if context == nil {
			continue
		}
		_, belongsToShot := shotIDs[context.ShotID]
		if context.ChapterID == unitID || belongsToShot {
			result.Tasks = append(result.Tasks, task)
		}
	}
	return result, nil
}

func (s *Service) ProjectCanvasesPage(userID string, projectID string, page int, pageSize int) (ProjectCanvasPage, error) {
	return s.projectDomain().ProjectCanvasesPage(userID, projectID, page, pageSize)
}

func (s *Service) ProjectAssetCandidatesPage(userID string, projectID string, page int, pageSize int, unitID string, status string, category string, query string) (ProjectAssetCandidatePage, error) {
	if _, err := s.projectDomain().Owned(userID, projectID); err != nil {
		return ProjectAssetCandidatePage{}, err
	}
	page, pageSize = normalizeProjectPage(page, pageSize, 200)
	candidates, total, err := s.repo.ProjectAssetCandidatesPage(projectID, page, pageSize, unitID, status, category, query)
	if err != nil {
		return ProjectAssetCandidatePage{}, err
	}
	return ProjectAssetCandidatePage{Candidates: candidates, Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total}, nil
}

func (s *Service) ProjectAssetsPage(userID string, projectID string, page int, pageSize int, category string, mediaType string, status string, folderID *string, query string) (ProjectAssetPage, error) {
	if _, err := s.projectDomain().Owned(userID, projectID); err != nil {
		return ProjectAssetPage{}, err
	}
	page, pageSize = normalizeProjectPage(page, pageSize, 80)
	assets, total, err := s.repo.ProjectAssetsPage(userID, projectID, page, pageSize, category, mediaType, status, folderID, query)
	if err != nil {
		return ProjectAssetPage{}, err
	}
	summaries := make([]ProjectAssetSummary, len(assets))
	var group errgroup.Group
	group.SetLimit(8)
	for index := range assets {
		index := index
		group.Go(func() error {
			summary, summaryErr := s.projectAssetSummary(userID, projectID, &assets[index])
			if summaryErr != nil {
				return summaryErr
			}
			summaries[index] = summary
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return ProjectAssetPage{}, err
	}
	categoryRows, folderRows, err := s.repo.ProjectAssetFacets(projectID)
	if err != nil {
		return ProjectAssetPage{}, err
	}
	categoryCounts := make(map[string]int64, len(categoryRows))
	for _, row := range categoryRows {
		categoryCounts[row.Key] = row.Count
	}
	folderCounts := make(map[string]int64, len(folderRows))
	for _, row := range folderRows {
		folderCounts[row.Key] = row.Count
	}
	return ProjectAssetPage{Assets: summaries, CategoryCounts: categoryCounts, FolderCounts: folderCounts, Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total}, nil
}

func normalizeProjectPage(page int, pageSize int, maximum int) (int, int) {
	return localproject.NormalizePage(page, pageSize, maximum)
}
