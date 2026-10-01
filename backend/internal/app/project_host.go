package app

import localproject "infinite-canvas/backend/internal/project"

type projectWorkflowHost struct {
	service *Service
}

func (h projectWorkflowHost) EnsureBuiltinTemplate() error {
	return h.service.EnsureBuiltinProjectWorkflowTemplate()
}

func (h projectWorkflowHost) PrepareDefault(projectID string) (localproject.WorkflowSeed, error) {
	instance, steps, err := h.service.newProjectWorkflowRecords(projectID, "", "project")
	if err != nil {
		return localproject.WorkflowSeed{}, err
	}
	return localproject.WorkflowSeed{Instance: instance, Steps: steps}, nil
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
