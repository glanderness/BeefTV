package beeftv

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMediaClientEstimatePricingSendsWireRequestAndParsesResponse(t *testing.T) {
	var gotAuth, gotPath, gotMethod string
	var gotReq PricingEstimateRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"items": [
				{
					"amount": 1.2207,
					"approx": false,
					"label": "¥1.22",
					"variable": false,
					"basis": "768p ¥0.2441/秒 × 5 秒",
					"text": "¥1.22（768p ¥0.2441/秒 × 5 秒）",
					"reserve": null
				}
			],
			"summary": {
				"amount": 1.2207,
				"priced": 1,
				"unknown": 0,
				"approx": false,
				"text": "预计费用：¥1.22"
			}
		}`))
	}))
	defer server.Close()

	client := &MediaClient{BaseURL: server.URL, APIKey: "sk-estimate-key", AllowHTTPTest: true}
	req := PricingEstimateRequest{
		Targets: []PricingEstimateTarget{{
			Model:      "minimax-h3-max-turbo",
			Kind:       "video",
			Count:      1,
			Resolution: "768p",
			Seconds:    5,
		}},
	}
	resp, err := client.EstimatePricing(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimatePricing failed: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/pricing/estimate" || gotAuth != "Bearer sk-estimate-key" {
		t.Fatalf("unexpected wire request: method=%s path=%s auth=%s", gotMethod, gotPath, gotAuth)
	}
	if len(gotReq.Targets) != 1 || gotReq.Targets[0].Model != "minimax-h3-max-turbo" || gotReq.Targets[0].Resolution != "768p" || gotReq.Targets[0].Seconds != 5 {
		t.Fatalf("unexpected encoded targets: %+v", gotReq)
	}
	if len(resp.Items) != 1 || resp.Items[0].Amount == nil || *resp.Items[0].Amount != 1.2207 || resp.Summary.Text != "预计费用：¥1.22" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestServiceEstimatePricingUsesConnectedCredentialAndRejectsBadResponses(t *testing.T) {
	status := http.StatusOK
	body := `{"items":[{"amount":2.5,"label":"¥2.5","basis":"服务端定价","text":"¥2.5（服务端定价）"}],"summary":{"amount":2.5,"priced":1,"unknown":0,"text":"预计费用：¥2.5"}}`
	var seenAuth, seenPath string
	svc := newConnectedTopUpTestServiceWithOpen(t, func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		seenPath = r.URL.Path
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}, nil)

	req := PricingEstimateRequest{
		Targets: []PricingEstimateTarget{{Model: "minimax-h3-max-turbo", Kind: "video", Count: 1, Resolution: "768p", Seconds: 5}},
	}
	resp, err := svc.EstimatePricing(context.Background(), req)
	if err != nil {
		t.Fatalf("Service.EstimatePricing failed: %v", err)
	}
	if seenPath != "/v1/pricing/estimate" || seenAuth != "Bearer sk-test-desktop-token" {
		t.Fatalf("unexpected request metadata: path=%s auth=%s", seenPath, seenAuth)
	}
	if len(resp.Items) != 1 || resp.Items[0].Amount == nil || *resp.Items[0].Amount != 2.5 || resp.Summary.Text != "预计费用：¥2.5" {
		t.Fatalf("unexpected response: %+v", resp)
	}

	// Non-200 response fails cleanly so callers can fall back.
	status = http.StatusNotFound
	if _, err := svc.EstimatePricing(context.Background(), req); err == nil {
		t.Fatal("expected error on 404 response")
	}

	// Mismatched item count is rejected.
	status = http.StatusOK
	body = `{"items":[],"summary":{"text":"预计费用：暂无价格"}}`
	if _, err := svc.EstimatePricing(context.Background(), req); err == nil {
		t.Fatal("expected error on mismatched item count")
	}

	// Disconnected service returns error without dialing.
	var nilSvc *Service
	if _, err := nilSvc.EstimatePricing(context.Background(), req); err == nil {
		t.Fatal("expected error on nil service")
	}
}
