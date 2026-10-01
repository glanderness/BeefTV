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
	if err := requireTaskRuntime(ctx); err != nil {
		return nil, err
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

func requireTaskRuntime(ctx context.Context) error {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok {
		return errors.New("无法执行生成任务，请重试")
	}
	if strings.TrimSpace(runtime.Call.UserID) == "" || strings.TrimSpace(runtime.Call.TaskID) == "" {
		return errors.New("生成任务缺少用户或任务身份")
	}
	if runtime.Images == nil || runtime.Receipts == nil {
		return errors.New("无法执行生成任务，请重试")
	}
	return nil
}
