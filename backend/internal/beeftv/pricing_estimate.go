package beeftv

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/pricing"
)

const pricingEstimateTimeout = 3 * time.Second

type PricingEstimateTarget struct {
	Model           string  `json:"model"`
	Kind            string  `json:"kind"`
	Size            string  `json:"size"`
	Quality         string  `json:"quality"`
	Layers          bool    `json:"layers"`
	Count           int     `json:"count"`
	ReferenceImages int     `json:"referenceImages"`
	ReferenceVideos int     `json:"referenceVideos"`
	Resolution      string  `json:"resolution"`
	Seconds         float64 `json:"seconds"`
	Characters      int     `json:"characters"`
}

type PricingEstimateRequest struct {
	Targets []PricingEstimateTarget `json:"targets"`
}

type PricingEstimateResponse struct {
	Items   []pricing.Estimate `json:"items"`
	Summary pricing.Summary    `json:"summary"`
}

func validatePricingEstimateResponse(resp PricingEstimateResponse, want int) error {
	if len(resp.Items) != want {
		return errors.New("服务端估价数量与请求不一致")
	}
	for _, item := range resp.Items {
		if item.Amount != nil && (math.IsNaN(*item.Amount) || math.IsInf(*item.Amount, 0) || *item.Amount < 0) {
			return errors.New("服务端估价金额无效")
		}
		if item.Reserve != nil && (math.IsNaN(*item.Reserve) || math.IsInf(*item.Reserve, 0) || *item.Reserve < 0) {
			return errors.New("服务端估价预扣金额无效")
		}
		if strings.TrimSpace(item.Text) == "" && strings.TrimSpace(item.Basis) == "" {
			return errors.New("服务端估价缺少说明")
		}
	}
	return nil
}

func (c *MediaClient) EstimatePricing(ctx context.Context, req PricingEstimateRequest) (PricingEstimateResponse, error) {
	if len(req.Targets) == 0 {
		return PricingEstimateResponse{}, errors.New("估价目标不能为空")
	}
	var resp PricingEstimateResponse
	if err := c.LegacyJSON(ctx, http.MethodPost, "/pricing/estimate", req, &resp); err != nil {
		return PricingEstimateResponse{}, err
	}
	if err := validatePricingEstimateResponse(resp, len(req.Targets)); err != nil {
		return PricingEstimateResponse{}, err
	}
	return resp, nil
}

func (s *Service) EstimatePricing(ctx context.Context, req PricingEstimateRequest) (PricingEstimateResponse, error) {
	if s == nil {
		return PricingEstimateResponse{}, errNotConnected
	}
	if len(req.Targets) == 0 {
		return PricingEstimateResponse{}, errors.New("估价目标不能为空")
	}
	cred, err := s.Resolve()
	if err != nil {
		return PricingEstimateResponse{}, err
	}
	reqCtx := ctx
	if reqCtx == nil {
		reqCtx = s.lifecycle
	}
	boundedCtx, cancel := context.WithTimeout(reqCtx, pricingEstimateTimeout)
	defer cancel()
	origin := s.Origin()
	client := &MediaClient{
		BaseURL:       TokenBaseURL(origin),
		APIKey:        cred.APIKey,
		Client:        s.httpClient,
		AllowHTTPTest: strings.HasPrefix(origin, "http://"),
	}
	return client.EstimatePricing(boundedCtx, req)
}
