package app

import localproject "infinite-canvas/backend/internal/project"

type projectWorkflowHost struct {
	service *Service
}

func (h projectWorkflowHost) EnsureBuiltinTemplate() error {
	return h.service.EnsureBuiltinProjectWorkflowTemplate()
}

func (h projectWorkflowHost) CreateDefault(projectID string) error {
	_, err := h.service.createProjectWorkflow(projectID, "", "project")
	return err
}

func (s *Service) ProjectService() *localproject.Service {
	return s.projectDomain()
}

func (s *Service) projectDomain() *localproject.Service {
	if s.projects != nil {
		return s.projects
	}
	s.projects = localproject.New(s.repo, localproject.Dependencies{Workflows: projectWorkflowHost{service: s}})
	return s.projects
}
