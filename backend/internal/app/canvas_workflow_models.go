package app

import cw "infinite-canvas/backend/internal/canvasworkflow"

func (s *Service) selectWorkflowModel(n cw.Node, recipe *workflowRecipe) (bool, error) {
	return cw.SelectModel(s.compileHost(), n, recipe)
}
