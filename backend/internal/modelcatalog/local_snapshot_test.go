package modelcatalog

import "testing"

func TestParseLocalChannelModels(t *testing.T) {
	body := []byte(`{"channels":[{"id":"ch1","baseUrl":"https://example.com/v1","enabled":true,"models":["img","skip"],"modelProfiles":[{"model":"img","displayName":"Image","capability":"image","protocol":"openai-image"}]}]}`)
	items := ParseLocalChannelModels(body)
	if len(items) != 2 || items[0].Model != "img" || items[0].DisplayName != "Image" {
		t.Fatalf("parsed = %#v", items)
	}
}
