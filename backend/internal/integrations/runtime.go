// Package integrations is the shell composition point. Setting
// BEEFTV_INTEGRATION=local restores the official local-only runtime.
package integrations

import (
	"context"
	"fmt"
	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/integrations/aihubkit"
	"os"
	"strings"
)

func Open(ctx context.Context, cfg bootstrap.Config) (bootstrap.HostRuntime, error) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("BEEFTV_INTEGRATION"))) {
	case "", "aihubkit":
		return aihubkit.Open(ctx, cfg)
	case "local":
		return bootstrap.Open(ctx, cfg)
	default:
		return nil, fmt.Errorf("BEEFTV_INTEGRATION 必须为 aihubkit 或 local")
	}
}
