package generation

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Execute runs a resolved image/text/video/audio request. Config, secrets,
// hydration and workflow routing stay in the app adapter; this function does
// not look up channels or start RunningHub jobs.
func Execute(ctx context.Context, input Input) (map[string]any, error) {
	if strings.TrimSpace(input.Prompt) == "" {
		return nil, errors.New("prompt is required")
	}
	switch input.Mode {
	case "image":
		return RunImageTask(ctx, input)
	case "text":
		if input.AgentRequests != nil {
			return RunAgentToolTask(ctx, input)
		}
		return RunTextTask(ctx, input)
	case "video":
		return RunVideoTask(ctx, input)
	case "audio":
		return RunAudioTask(ctx, input)
	default:
		return nil, fmt.Errorf("不支持的生成模式：%s", input.Mode)
	}
}
