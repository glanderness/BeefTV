package app

func (s *Service) PublicLogicalModels(intent *ModelRequestIntent) ([]PublicLogicalModel, error) {
	return s.ensureRouter().PublicLogicalModels(intent)
}
