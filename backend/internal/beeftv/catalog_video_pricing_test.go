package beeftv

import (
	"encoding/json"
	"infinite-canvas/backend/internal/pricing"
	"infinite-canvas/backend/internal/workspace"
	"testing"
)

func TestPortraitQuoteRefreshAndRemoval(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	model := CatalogModel{ID: "seedance-2.0-portrait", DisplayName: "Seedance 2.0 真人素材版", VideoPricing: json.RawMessage(`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`)}
	if err := applyCatalog(store, []CatalogModel{model}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	profile := catalogProfile(t, store, model.ID)
	if profile["videoPricing"] == nil {
		t.Fatal("price was dropped before reaching the UI")
	}
	model.VideoPricing = nil
	if err := applyCatalog(store, []CatalogModel{model}, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	if catalogProfile(t, store, model.ID)["videoPricing"] != nil {
		t.Fatal("missing current price retained a stale quote")
	}
}

func TestPortraitQuoteRejectsInvalidRates(t *testing.T) {
	for _, raw := range []string{
		`{"currency":"USD","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`,
		`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":0,"reference_video":42}}}`,
		`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69}}}`,
	} {
		if _, ok := NormalizeCatalogVideoPricing(json.RawMessage(raw)); ok {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestVideoReferenceInvoiceQuoteSurvivesCatalogRefresh(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	item := CatalogModel{ID: "minimax-h3-max-turbo", VideoPricing: json.RawMessage(`{"currency":"CNY","mode":"seconds","rates":{"768p":{"output":0.25,"reference_video":0}},"reference_invoice":{"usd_cny":7.2,"reserve_usd":5,"token":"private"}}`)}
	if err := applyCatalog(store, []CatalogModel{item}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	price := catalogProfile(t, store, item.ID)["videoPricing"].(map[string]any)
	invoice, ok := price["reference_invoice"].(map[string]any)
	if !ok || invoice["usd_cny"] != 7.2 || invoice["reserve_usd"] != float64(5) || len(invoice) != 2 {
		t.Fatalf("invoice quote lost: %#v", price)
	}
	for _, raw := range []string{
		`{"currency":"CNY","mode":"seconds","rates":{"768p":{"output":0.25,"reference_video":0}},"reference_invoice":{"usd_cny":7.2,"reserve_usd":0}}`,
		`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":20,"reference_video":12}},"reference_invoice":{"usd_cny":7.2,"reserve_usd":5}}`,
	} {
		if _, ok := NormalizeCatalogVideoPricing(json.RawMessage(raw)); ok {
			t.Fatalf("accepted invalid invoice: %s", raw)
		}
	}
}

func TestPortraitRemovedFromCatalogDoesNotRetainQuoteOrAvailability(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	portrait := CatalogModel{ID: "seedance-2.0-portrait", VideoPricing: json.RawMessage(`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`)}
	if err := applyCatalog(store, []CatalogModel{portrait}, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, []CatalogModel{{ID: "seedance-2.0"}}, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channels, _ := effective.Config["channels"].([]any)
	for _, raw := range channels {
		channel, _ := raw.(map[string]any)
		if channel["id"] != ChannelID {
			continue
		}
		models, _ := channel["models"].([]any)
		for _, model := range models {
			if model == portrait.ID {
				t.Fatal("removed portrait is still available")
			}
		}
		profiles, _ := channel["modelProfiles"].([]any)
		for _, rawProfile := range profiles {
			profile, _ := rawProfile.(map[string]any)
			if profile["model"] == portrait.ID {
				t.Fatal("removed portrait retains a stale profile/quote")
			}
		}
	}
}

func TestVideoPricingDisplayLinesSurviveCatalogRefresh(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	item := CatalogModel{
		ID: "minimax-h3-max-turbo",
		VideoPricing: json.RawMessage(`{
			"currency": "CNY",
			"mode": "seconds",
			"rates": {"480p": {"output": 0.1526, "reference_video": 0}, "768p": {"output": 0.2441, "reference_video": 0}},
			"display_lines": ["  480p：¥0.1526 / 秒  ", "", "768p：¥0.2441 / 秒"]
		}`),
	}
	if err := applyCatalog(store, []CatalogModel{item}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	price, ok := catalogProfile(t, store, item.ID)["videoPricing"].(map[string]any)
	if !ok {
		t.Fatalf("videoPricing missing after refresh")
	}
	lines, ok := price["display_lines"].([]any)
	if !ok || len(lines) != 2 || lines[0] != "480p：¥0.1526 / 秒" || lines[1] != "768p：¥0.2441 / 秒" {
		t.Fatalf("unexpected display_lines: %#v", price["display_lines"])
	}
}

func TestVideoPricingDisplayLinesSurviveWithoutLegacyRatesOrWith1440p(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	displayOnly := CatalogModel{
		ID:           "future-display-only",
		VideoPricing: json.RawMessage(`{"display_lines":["  1440p：¥0.88 / 秒  ","","按官方动态档位结算"]}`),
	}
	with1440p := CatalogModel{
		ID: "future-1440p-video",
		VideoPricing: json.RawMessage(`{
			"currency": "CNY",
			"mode": "seconds",
			"rates": {"1440p": {"output": 0.88, "reference_video": 0}},
			"display_lines": ["1440p：¥0.88 / 秒"]
		}`),
	}
	if err := applyCatalog(store, []CatalogModel{displayOnly, with1440p}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id   string
		want []string
	}{
		{id: "future-display-only", want: []string{"1440p：¥0.88 / 秒", "按官方动态档位结算"}},
		{id: "future-1440p-video", want: []string{"1440p：¥0.88 / 秒"}},
	} {
		price, ok := catalogProfile(t, store, tc.id)["videoPricing"].(map[string]any)
		if !ok {
			t.Fatalf("%s videoPricing missing after refresh", tc.id)
		}
		lines, ok := price["display_lines"].([]any)
		if !ok || len(lines) != len(tc.want) {
			t.Fatalf("%s unexpected display_lines: %#v", tc.id, price["display_lines"])
		}
		for i, wantLine := range tc.want {
			if lines[i] != wantLine {
				t.Fatalf("%s display_lines[%d] = %v, want %q", tc.id, i, lines[i], wantLine)
			}
		}
		if pricing.FromVideoQuote(price) != nil {
			t.Fatalf("%s display_lines-only fallback must not invent local pricing table", tc.id)
		}
	}
	// Without display_lines, an unknown legacy rate resolution is still rejected.
	if _, ok := NormalizeCatalogVideoPricing(json.RawMessage(`{"currency":"CNY","mode":"seconds","rates":{"1440p":{"output":0.88,"reference_video":0}}}`)); ok {
		t.Fatal("accepted 1440p legacy rate without display_lines")
	}
}
