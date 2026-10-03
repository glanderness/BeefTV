# ChatGPT 订阅

ChatGPT 订阅协议让工作区直接使用 ChatGPT Plus/Pro 等订阅额度进行文本生成，而不是按量计费的 API Key。它复用 OpenAI Responses 线协议，但端点、账号隔离头和请求体约束由 ChatGPT 后端决定。

> 重要边界：ChatGPT 订阅没有官方 API。本协议复刻的是 OpenAI Codex CLI 使用的未公开端点，随时可能变化，且订阅条款是否允许第三方客户端使用需要部署者自行确认。协议失败时应回退到官方 API 或其它渠道，而不是把它当作稳定合同。

## 接口、鉴权与请求模式

{{OPERATIONS}}

```http
POST {channel_base_url}/responses
Authorization: Bearer <access_token>
chatgpt-account-id: <account_id>
originator: codex_cli_rs
Content-Type: application/json
```

渠道 Base URL 应填写 `https://chatgpt.com/backend-api/codex`。`access_token` 不是用户在渠道里手工填写的 API Key，而是由宿主在**任务执行期**用已保存的 `refresh_token` 换取的短期令牌；`chatgpt-account-id` 由同一份令牌的 JWT 声明解析得到。两者都只在内存中存在，不写入任务载荷。

ChatGPT 后端只接受流式 Responses 请求，因此宿主固定发送 `stream: true`，并按用户是否开启流式决定要不要把增量推送给前端。非流式开关只会影响前端展示，不会改变上游请求形状。

## 模型与兼容边界

模型名必须填写订阅实际上可用的模型 ID，例如 `gpt-5-codex` 一类由 Codex 后端暴露的模型。宿主不会维护白名单，也不会根据模型名猜测额度或能力。订阅可用模型与官方 API 的模型集合并不相同，填写官方 API 模型名不一定可用。

请求体固定包含 `store: false` 和 `include: ["reasoning.encrypted_content"]`。`instructions` 来自渠道系统提示词，为空时由适配器补一个最小默认值，因为该后端要求请求带指令。不要在这一协议上假设支持图片、视频或音频。

## 参数与字段映射

{{PARAMETERS}}

可通过 `extra` 透传 `instructions`、`temperature`、`top_p`、`max_output_tokens`、`text` 和 `tools`。适配器在合并扩展参数之后仍会把 `stream` 强制回 `true`，避免上游因为非流式请求直接拒绝。

## 完整请求示例

```bash
curl "https://chatgpt.com/backend-api/codex/responses" \
  -H "Authorization: Bearer <access_token>" \
  -H "chatgpt-account-id: <account_id>" \
  -H "originator: codex_cli_rs" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-codex",
    "input": "把这场雨夜追逐拆成 6 个镜头。",
    "instructions": "你是影视分镜助理。",
    "stream": true,
    "store": false,
    "include": ["reasoning.encrypted_content"]
  }'
```

上游以 SSE 返回，宿主文本任务流负责组装事件、提取正文与推理摘要，并保留真实错误。HTTP 状态、业务错误和缺少正文都不会被改写为成功。

## 响应解析、流式与错误

响应解析读取 Responses 协议的 `output_text`，缺失时回退到 `output` 数组中的文本分片，并保留 `usage`。流式事件由宿主文本解析器消费，正文增量进入文本任务 SSE，推理摘要进入独立的推理通道。

常见失败包括：授权已过期（需要重新连接）、账号缺少订阅或模型不可用、请求头不符合后端要求、上游限流。授权被上游永久拒绝时，宿主会把该用户的本地凭据标记为失效并要求重新连接，不会静默退回其它渠道。

## 官方资料

- [OpenAI Codex 仓库](https://github.com/openai/codex)
- [OpenAI Codex 认证说明](https://developers.openai.com/codex/auth)

{{CONTRACT}}
