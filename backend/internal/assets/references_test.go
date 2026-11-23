package assets

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReferenceCollectorsPreserveScalarAndNestedLocators(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{`"/api/resources/media/file"`, "media"},
		{`"resource:media"`, "media"},
		{`{"prompt":"resource:ignored","nested":{"resourceIds":["first","second"],"content":"/api/resources/first/file"}}`, "first,second"},
		{`{"nodes":[{"metadata":{"storageKey":"resource:ab1e3cd"}}],"prompt":"escaped \\\" 1e1000"}`, "ab1e3cd"},
		{`{"resourceId":"media","custom":1e2}`, "media"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			var decoded any
			decoder := json.NewDecoder(strings.NewReader(tc.raw))
			decoder.UseNumber()
			if err := decoder.Decode(&decoded); err != nil {
				t.Fatal(err)
			}
			for _, collect := range []func(map[string]struct{}) error{
				func(refs map[string]struct{}) error { return CollectOwnedDocumentReferences(tc.raw, refs) },
				func(refs map[string]struct{}) error {
					return CollectOwnedDocumentReferencesFromDecoded(tc.raw, decoded, refs)
				},
			} {
				refs := map[string]struct{}{}
				if err := collect(refs); err != nil {
					t.Fatal(err)
				}
				if got := strings.Join(SortedIDs(refs), ","); got != tc.want {
					t.Fatalf("references = %s, want %s", got, tc.want)
				}
			}
		})
	}
}

func TestReferenceNumberValidationSkipsQuotedText(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{`{"resourceId":"ab1e3cd","value":1.25}`, false},
		{`{"prompt":"` + strings.Repeat("9", 400) + ` 1e1000"}`, false},
		{`{"prompt":"escaped \\\" 1e1000","value":1}`, false},
		{`{"prompt":"escaped \\\" 1e1000","value":1e1000}`, true},
		{`{"value":-1E+309}`, true},
		{`{"value":` + strings.Repeat("9", 309) + `}`, true},
		{`{"value":` + strings.Repeat("9", 250) + `e99}`, true},
	} {
		if !json.Valid([]byte(tc.raw)) {
			t.Fatalf("invalid fixture: %s", tc.raw)
		}
		if got := referenceNumbersNeedValidation(tc.raw); got != tc.want {
			t.Errorf("range check = %v, want %v: %s", got, tc.want, tc.raw)
		}
	}
}

func TestDocumentReferencedIDsPrefilterPreservesAllEdgeCases(t *testing.T) {
	targets := map[string]struct{}{
		"res-target-1": {},
		"res_target_2": {},
	}
	for _, tc := range []struct {
		name string
		raw  string
		want string
	}{
		{"plain locator storageKey", `{"storageKey":"resource:res-target-1"}`, "res-target-1"},
		{"plain locator file url", `{"imageUrl":"/api/resources/res_target_2/file?v=1"}`, "res_target_2"},
		{"unicode escaped colon", `{"storageKey":"resource\u003ares-target-1"}`, "res-target-1"},
		{"escaped slash url", `{"url":"\/api\/resources\/res-target-1\/file"}`, "res-target-1"},
		{"whitespace padded locator", `{"storageKey":"  resource:  res-target-1  "}`, "res-target-1"},
		{"bare resourceId", `{"resourceId":"res-target-1"}`, "res-target-1"},
		{"bare resourceIds nested array", `{"referenceResourceIds":[["res-other","res_target_2"]]}`, "res_target_2"},
		{"bare sampleResourceId padded", `{"sampleResourceId":" res-target-1 "}`, "res-target-1"},
		{"prompt text ignored despite locator substring", `{"prompt":"resource:res-target-1 /api/resources/res_target_2/file"}`, ""},
		{"other resources skipped without match", `{"nodes":[{"storageKey":"resource:res-other-1","url":"/api/resources/res-other-2/file","resourceId":"res-other-3"}]}`, ""},
		{"non-json scalar locator", `resource:res-target-1`, "res-target-1"},
		{"json scalar file url", `"/api/resources/res_target_2/file"`, "res_target_2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := strings.Join(SortedIDs(DocumentReferencedIDs(tc.raw, targets)), ",")
			if got != tc.want {
				t.Fatalf("DocumentReferencedIDs(%s) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestDocumentContainsLocatorSinglePass(t *testing.T) {
	targets := map[string]struct{}{
		"res-a": {},
		"res-b": {},
	}
	if !DocumentContainsLocator(`{"a":"resource:res-other","b":"resource:res-a"}`, targets) {
		t.Fatal("expected storageKey match")
	}
	if !DocumentContainsLocator(`{"a":"/api/resources/res-other/file","b":"/api/resources/res-b/file"}`, targets) {
		t.Fatal("expected file URL match")
	}
	if DocumentContainsLocator(`{"a":"resource:res-a-longer","b":"/api/resources/res-b-longer/file"}`, targets) {
		t.Fatal("prefix-only longer ID must not match")
	}
	if DocumentContainsLocator(`{"a":"resource:res-other"}`, targets) {
		t.Fatal("unrelated resource must not match")
	}
}
