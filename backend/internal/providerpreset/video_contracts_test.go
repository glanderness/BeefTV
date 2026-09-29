package providerpreset

import "testing"

func TestEveryDeclaredVideoContractHasKnownProtocolAndValidLimits(t *testing.T) {
	seen := map[string]bool{}
	for _, contract := range videoContracts {
		if len(contract.Models) == 0 || !knownProtocol(contract.Protocol) {
			t.Fatalf("invalid protocol contract: %#v", contract)
		}
		for _, name := range contract.Models {
			if name == "" || seen[name] {
				t.Fatalf("empty or duplicate model: %q", name)
			}
			seen[name] = true
		}
		for kind, count := range contract.MaxReferences {
			if (kind != "image" && kind != "video" && kind != "audio") || count < 0 {
				t.Fatalf("invalid reference limit: %s=%d", kind, count)
			}
		}
	}
}

func TestVideoContractBoundaries(t *testing.T) {
	for _, name := range []string{"wan3.0-video", "seedance-2.0-fast", "seedance-2.5"} {
		contract, ok := BeefAPIVideoContract(name)
		if !ok || !knownProtocol(contract.Protocol) || !contract.InlineMedia {
			t.Fatalf("missing verified contract for %s", name)
		}
	}
	for _, name := range []string{"wan3.0-video-prime", "wan4.0-video", "seedance-2.50", "future-video"} {
		if _, ok := BeefAPIVideoContract(name); ok {
			t.Fatalf("unverified model matched: %s", name)
		}
	}
	for _, base := range []string{"https://enterprise.beefapi.com.evil.test", "https://evil.test/enterprise.beefapi.com", "http://enterprise.beefapi.com", "https://user@enterprise.beefapi.com", "https://enterprise.beefapi.com:444"} {
		if IsBeefAPIEndpoint(base) {
			t.Fatalf("untrusted endpoint: %s", base)
		}
	}
	if !IsBeefAPIEndpoint("https://enterprise.beefapi.com/v1") {
		t.Fatal("canonical endpoint rejected")
	}
}
