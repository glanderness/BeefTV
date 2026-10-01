# 切片：助手宿主进程生命周期抽到 `assistantruntime`

把内置创作助手宿主的子进程生命周期从 HTTP handler 抽到 `backend/internal/assistantruntime`。handler 只解码请求、投影响应；bootstrap 持有 Host 的寿命。

## 边界

- 新包：`backend/internal/assistantruntime`
- 中立合同：`backend/internal/assistant` 持有 Provider / UnavailableError / reason / Fingerprint。`app` 用类型别名保留既有调用方名称；渠道选择算法仍在 `app.Service.ResolveAssistantProvider`，经函数注入运行时。
- handler：`agent_host_lifecycle.go` 变为路由适配；`RuntimeDependencies.AssistantHost` 在路由注册时注入同一实例；`agent_proxy.go` 只改启停/状态查询的调用点。缺失 Host 时明确返回 `host_unreachable`，不得在请求里 `New` 一个随后被丢掉的监督器。
- bootstrap：`Runtime` 持有 `*assistantruntime.Host`，桌面 `Start` 拉起、`Close` 回收。父运行时是唯一的 `Close` 所有者。
- 未改：`agent-host/` JS/SDK、`agentops`、database/model、`assistant_turns`、对话代理与 `/health` 探测语义

## 行为保留

- 每个子进程只 `Wait` 一次
- Windows 先 `Kill`，其他平台 `SIGTERM` → 5s → `Kill` → 3s
- 配置原子写、权限 0600；`GET /assistant/host/config` 只回 `hasKey`，不回密钥
- 未配置命令或模型未解析时，启动链 `Start` 是 no-op
- 空闲且供应商指纹变化才重启；忙碌时不打断
- 随包 Node 路径按 darwin `Contents/Resources/agent-host` 与 Windows 旁路 `agent-host` 解析，不回退 PATH
- `Ensure` / `Restart` / `Stop` / `Start` / `Launch` 在 Host 生命周期锁上串行，避免互相抢到半回收的子进程

## 依赖

`assistantruntime` 只依赖：

- 标准库进程/文件 API
- `internal/assistant` 的 Provider 合同
- 通过 `ProviderService` / `ResolveProvider` 注入的解析函数（`*app.Service` 满足该接口，但本包不得 import `internal/app`）
- 不依赖 gin、handler、agentops

`app` 可以依赖 `assistant` 做别名；新领域包不得反向 import `app`。

组合根把同一个 Host 放进 `RuntimeDependencies.AssistantHost`，生命周期路由与代理路由拿到同一指针。两个 `Host` 不共享子进程所有权。禁止按 `dataDir` 做进程级 Host 表。

独立路由注册也不创建 Host；需要助手的调用方必须注入有明确 Close 所有者的实例。缺失时保持不可用，避免开发入口产生无人回收的子进程。

## 验证

```bash
cd backend
go test ./internal/assistantruntime ./internal/handler ./internal/bootstrap ./internal/assistant ./internal/app
```

确定性进程夹具覆盖 restart / stop / crash、多 Host 隔离、并发 Ensure/Restart/Stop，以及 HTTP 层重复 status/start/stop 共享同一 Host。
