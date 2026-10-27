package app

import (
	"net/http"
	"testing"
)

func TestImageJobIDFromHeadersPrefersGatewayIdentityAndSupportsLocation(t *testing.T) {
	if got := imageJobIDFromHeaders(http.Header{"X-Image-Job-Id": []string{"header-job"}, "Location": []string{"https://api.example/v1/images/jobs/location-job"}}); got != "header-job" {
		t.Fatalf("header job id = %q", got)
	}
	if got := imageJobIDFromHeaders(http.Header{"Location": []string{"https://api.example/v1/images/jobs/location-job/"}}); got != "location-job" {
		t.Fatalf("location job id = %q", got)
	}
	if got := imageJobIDFromHeaders(http.Header{"Location": []string{"https://api.example/v1/images/generations/not-a-job"}}); got != "" {
		t.Fatalf("unrelated location became job id: %q", got)
	}
}
