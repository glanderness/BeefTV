package app

import (
	"infinite-canvas/backend/internal/admin"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) RequireAdmin(user *model.User) error { return admin.RequireAdmin(user) }
func (s *Service) PublicSystemChannels() ([]PublicModelChannel, error) {
	return admin.PublicSystemChannels(s.repo)
}
func (s *Service) SystemChannel(id string) (*model.ModelChannel, error) {
	return admin.SystemChannel(s.repo, s.decryptSettingSecret, id)
}
func (s *Service) LogAPICall(log model.ApiCallLog) error {
	return admin.LogAPICall(s.repo, &s.storageMu, s.RuntimePolicy, defaultVideoPollInterval, log)
}
