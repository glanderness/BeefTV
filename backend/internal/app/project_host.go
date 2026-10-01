package app

import localproject "infinite-canvas/backend/internal/project"

type projectWorkflowHost struct {
	service *Service
}

func (h projectWorkflowHost) EnsureBuiltinTemplate() error {
	return h.service.projectDomain().EnsureBuiltinTemplate()
}

func (h projectWorkflowHost) PrepareDefault(projectID string) (localproject.WorkflowSeed, error) {
	return h.service.projectDomain().PrepareDefaultWorkflow(projectID)
}

func (s *Service) ProjectService() *localproject.Service {
	return s.projectDomain()
}

func (s *Service) projectDomain() *localproject.Service {
	if s.projects != nil {
		return s.projects
	}
	return localproject.New(s.repo, localproject.Dependencies{Workflows: projectWorkflowHost{service: s}})
}
