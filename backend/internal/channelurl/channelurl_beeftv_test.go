package channelurl

import "testing"

func TestCanonicalBeefTVOriginAndSkillHubEquivalence(t *testing.T) {
	validOrigins := map[string]string{
		"https://beeftv.cn":       BeefTVProductionOrigin,
		"https://BEEFTV.CN/":      BeefTVProductionOrigin,
		"https://beeftv.cn:443":   BeefTVProductionOrigin,
		"https://beeftv.app":      BeefTVLegacyOrigin,
		"https://beeftv.app:443/": BeefTVLegacyOrigin,
	}
	for raw, want := range validOrigins {
		got, ok := CanonicalBeefTVOrigin(raw)
		if !ok || got != want {
			t.Fatalf("CanonicalBeefTVOrigin(%q) = (%q, %v), want (%q, true)", raw, got, ok, want)
		}
	}
	for _, invalid := range []string{
		"",
		"http://beeftv.cn",
		"http://beeftv.app",
		"https://beeftv.cn:8443",
		"https://beeftv.app:8443",
		"https://user@beeftv.cn",
		"https://beeftv.cn/v1",
		"https://beeftv.cn?x=1",
		"https://beeftv.cn.evil.test",
		"https://sub.beeftv.cn",
	} {
		if _, ok := CanonicalBeefTVOrigin(invalid); ok {
			t.Fatalf("CanonicalBeefTVOrigin(%q) unexpectedly accepted", invalid)
		}
	}

	if !SameOfficialSkillHubEndpoint("https://beeftv.app/api/beeftv/skillhub/v1", "https://beeftv.cn/api/beeftv/skillhub/v1") {
		t.Fatal("expected beeftv.app and beeftv.cn SkillHub endpoints to be equivalent")
	}
	if SameOfficialSkillHubEndpoint("https://evil.example/api/beeftv/skillhub/v1", "https://beeftv.cn/api/beeftv/skillhub/v1") {
		t.Fatal("unexpected equivalence for non-official SkillHub endpoint")
	}
}
