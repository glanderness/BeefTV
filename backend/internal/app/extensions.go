package app

import (
	"infinite-canvas/backend/internal/generation"
)

// Extensions are optional host capabilities. The local application has no
// dependency on the account provider implementing these ports.
type Extensions struct {
	ResolveCredential func(ref string) (baseURL, apiKey string, handled bool, err error)
	ReferenceStorage  func(generation.Config) generation.ReferenceStoragePort
}

func (s *Service) SetExtensions(extensions Extensions) { s.extensions = extensions }

func (s *Service) resolveExtensionConfig(config providerConfig) (providerConfig, error) {
	if s.extensions.ResolveCredential == nil {
		return config, nil
	}
	base, key, handled, err := s.extensions.ResolveCredential(config.CredentialRef)
	if err != nil {
		return providerConfig{}, err
	}
	if handled {
		config.BaseURL, config.APIKey, config.ChannelID = base, key, ""
		// A managed credential must never be replaced by a caller supplied header.
		config.Headers = nil
	}
	return config, nil
}
