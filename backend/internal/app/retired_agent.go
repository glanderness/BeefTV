package app

import "infinite-canvas/backend/internal/model"

// 旧内置 Agent 的任务 operation。task_creation / task_worker 用这些标记拒绝
// 历史记录重新进入模型调用；字符串必须与库里已有行保持一致。
const cloudAgentOperation = "cloud_agent"

// 记忆压缩任务的 operation。它不以 cloud_agent 为前缀，但同样属于退场范围。
const cloudAgentMemoryCompactOp = "agent_memory_compact"

// task_worker.go 仍在每条生成任务上调用这两个钩子。压缩 operation 已在
// retiredAgentTask 处拒绝，钩子必须保持空实现，不能恢复调度或写记忆。
func (s *Service) markAgentMemoryCompactRunning(task model.Task) {}

func (s *Service) noteAgentMemoryCompactTask(task model.Task, result map[string]any, execErr error) {
}
