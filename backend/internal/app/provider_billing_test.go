package app

import (
	"net/http"
	"testing"
)

func TestProviderBillingStatesPreservesFieldPresenceAndNestedValues(t *testing.T) {
	usage, usagePresent, billing, billingPresent := providerBillingStates([]byte(`{
		"data": {"usage_state": "pending"},
		"job": {"billingState": ""}
	}`))
	if usage != "pending" || !usagePresent || billing != "" || !billingPresent {
		t.Fatalf("states = %q/%v %q/%v", usage, usagePresent, billing, billingPresent)
	}
}

func TestProviderBillingStatesTreatsNullAsPresent(t *testing.T) {
	_, usagePresent, _, billingPresent := providerBillingStates([]byte(`{"usage_state": null, "billing_state": null}`))
	if !usagePresent || !billingPresent {
		t.Fatalf("null states presence = %v/%v", usagePresent, billingPresent)
	}
}

func TestImageJobIDFromHeadersReadsExplicitAndLocationForms(t *testing.T) {
	cases := []struct {
		name    string
		headers http.Header
		want    string
	}{
		{name: "explicit", headers: http.Header{"X-Image-Job-Id": []string{"job-explicit"}}, want: "job-explicit"},
		{name: "location", headers: http.Header{"Location": []string{"https://beeftv.app/v1/images/jobs/job-location"}}, want: "job-location"},
		{name: "unrelated location", headers: http.Header{"Location": []string{"https://beeftv.app/v1/videos/job-video"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := imageJobIDFromHeaders(tc.headers); got != tc.want {
				t.Fatalf("job id = %q, want %q", got, tc.want)
			}
		})
	}
}
