package app

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
)

const managedBeefAPIRef = beefapi.CredentialRef

func (s *Service) SetBeefAPI(connection *beefapi.Service) {
	if s != nil {
		s.beefAPI = connection
	}
}

func (s *Service) BeefAPI() *beefapi.Service {
	if s == nil {
		return nil
	}
	return s.beefAPI
}

func (s *Service) resolveManagedBeefAPISecrets(input map[string]any) (map[string]any, error) {
	if input != nil && s.extensions.ResolveCredential != nil {
		config, _ := input["config"].(map[string]any)
		credentialRef := strings.TrimSpace(stringValue(config["credentialRef"]))
		base, key, handled, err := s.extensions.ResolveCredential(credentialRef)
		if err != nil {
			return nil, err
		}
		if handled {
			config["baseUrl"], config["apiKey"], config["channelId"] = base, key, ""
			delete(config, "headers")
			return input, nil
		}
	}
	return generation.ResolveManagedBeefAPISecrets(input, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) lookupBeefAPICredential() (apiKey, baseURL, accountID, tokenID string, err error) {
	return generation.LookupBeefAPICredential(s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) resolveChannelModelsRequest(input *ChannelModelsRequest) error {
	if input == nil {
		return nil
	}
	if s.extensions.ResolveCredential != nil {
		base, key, handled, err := s.extensions.ResolveCredential(input.CredentialRef)
		if err != nil {
			return err
		}
		if handled {
			input.BaseURL, input.APIKey = base, key
			return nil
		}
	}
	return generation.ResolveChannelModelsRequest(input, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) ResolveCustomRelayAPIKey(targetURL, incoming string) (string, error) {
	return s.resolveCustomRelayKey(targetURL, incoming)
}

func (s *Service) resolveCustomRelayKey(targetURL, incoming string) (string, error) {
	if s.extensions.ResolveCredential != nil {
		base, key, handled, err := s.extensions.ResolveCredential(incoming)
		if err != nil {
			return "", err
		}
		if handled {
			if !generation.SameCredentialOrigin(targetURL, base) {
				return "", errors.New("托管凭据不能发送到其他地址")
			}
			return key, nil
		}
	}
	return generation.ResolveCustomRelayKey(targetURL, incoming, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) noteBeefAPIProviderError(message string) {
	if s != nil {
		generation.NoteBeefAPIProviderError(s.beefAPI, message)
	}
}
