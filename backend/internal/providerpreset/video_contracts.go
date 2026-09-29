package providerpreset

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"strings"
)

// Video contracts describe verified gateway routes, not every model belonging
// to the same vendor. The desktop catalog and web configuration share this file.
//
//go:embed video_contracts.json
var videoContractJSON []byte

type VideoContract struct {
	Models        []string       `json:"models"`
	AllowSuffix   bool           `json:"allowSuffix"`
	Protocol      string         `json:"protocol"`
	InlineMedia   bool           `json:"inlineMedia"`
	MaxReferences map[string]int `json:"maxReferences,omitempty"`
	Operations    []string       `json:"operations,omitempty"`
}

var videoContracts = func() []VideoContract {
	var contracts []VideoContract
	if err := json.Unmarshal(videoContractJSON, &contracts); err != nil {
		panic(err)
	}
	return contracts
}()

func IsBeefAPIEndpoint(baseURL string) bool {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "enterprise.beefapi.com") && u.User == nil && (u.Port() == "" || u.Port() == "443")
}

func BeefAPIVideoContract(model string) (VideoContract, bool) {
	model = strings.ToLower(strings.TrimSpace(model))
	for _, contract := range videoContracts {
		for _, name := range contract.Models {
			if model == name || contract.AllowSuffix && strings.HasPrefix(model, name+"-") {
				return contract, true
			}
		}
	}
	return VideoContract{}, false
}
