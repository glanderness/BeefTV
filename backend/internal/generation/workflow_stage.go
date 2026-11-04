package generation

import "context"

// Display progress is best effort after the provider receipt is durable.
func UpdateWorkflowDisplayStage(ctx context.Context, stage string) {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Stages == nil {
		return
	}
	display := map[string]string{"submitted": "上游已受理，等待生成", "pending": "上游已受理，等待生成", "queued": "上游排队中", "running": "正在生成", "downloading": "正在下载生成结果", "succeeded": "正在保存生成结果"}[stage]
	if display != "" {
		_ = runtime.Stages.SetStage(ctx, display)
	}
}
