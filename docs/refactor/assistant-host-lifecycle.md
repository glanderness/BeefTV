# 切片：助手宿主进程生命周期抽到 `assistantruntime`

把内置创作助手宿主的子进程生命周期从 HTTP handler 抽到 `backend/internal/assistantruntime`。handler 只解码请求、投影响应；bootstrap 持有 Host 的寿命。

## 边界

- 新包：`backend/internal/assistantruntime`
- handler：`agent_host_lifecycle.go` 变为路由适配；`RuntimeDependencies.AssistantHost` 显式注入；`agent_proxy.go` 只改启停/状态查询的调用点
- bootstrap：`Runtime` 持有 `*assistantruntime.Host`，桌面 `Start` 拉起、`Close` 回收
- 未改：`agent-host/` JS/SDK、`agentops`、database/model、`assistant_turns`、对话代理与 `/health` 探测语义

## 行为保留

- 每个子进程只 `Wait` 一次
- Windows 先 `Kill`，其他平台 `SIGTERM` → 5s → `Kill` → 3s
- 配置原子写、权限 0600；`GET /assistant/host/config` 只回 `hasKey`，不回密钥
- 未配置命令或模型未解析时，启动链 `Start` 是 no-op
- 空闲且供应商指纹变化才重启；忙碌时不打断
- 随包 Node 路径按 darwin `Contents/Resources/agent-host` 与 Windows 旁路 `agent-host` 解析，不回退 PATH

## 依赖

`assistantruntime` 依赖：

- 标准库进程/文件 API
- `app.AssistantProvider` 与 `ResolveAssistantProvider`（通过 `ProviderService` / `ResolveProvider` 注入）
- 不依赖 gin、handler、agentops

组合根把同一个 Host 放进 `RuntimeDependencies.AssistantHost`，路由与关闭钩子不再共用包级全局监督器。两个 `Host` 不共享子进程所有权。

## 验证

```bash
cd backend
go test ./internal/assistantruntime ./internal/handler ./internal/bootstrap
```

确定性进程夹具覆盖 restart / stop / crash 与多 Host 隔离。
