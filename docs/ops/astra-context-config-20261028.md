# Astra 上下文窗口与压缩阈值配置（2026-10-28）

## 结论

- 目标：让 `gpt-6-astra` 的上下文窗口为 700000 token，自动压缩阈值 500000 token。
- 现状：**未配置**。Astra 目录默认 `context_window = 272000`，实际生效窗口 258400（见下）。
- Codex CLI 0.160.1 **只提供全局**（每个 `CODEX_HOME` 一份）的 `model_context_window` / `model_auto_compact_token_limit`，**没有按模型覆盖的配置**。
- 因此写入本机 agent 的 Codex 配置 `~/.tds/codex-home/config.toml` 会同时作用于该 home 里的**所有**模型。本机该 home 近两天实际跑过 `gpt-6-astra` 与 `gpt-6.1-sol`。
- 已隔离实测：`model_context_window = 700000` 时 Codex 记录的有效窗口是 **665000**（= 700000 × 95%）。
- **当前状态：等用户选择适用范围后再落地**（见文末「待决定」）。

## 1. 生效入口（本机实际读取方式）

- tds CLI v0.1.68 每个回合以 `codex app-server --listen stdio://` 启动 Codex，并把环境变量 `CODEX_HOME` 固定为 `~/.tds/codex-home`（`spawnAppServer`，`env: { ...process.env, ...opts.env, CODEX_HOME: opts.codexHome }`）。命令行里没有任何 `-c` / `--profile` 覆盖。
- 模型按回合由平台下发（`turnModel(provider, step.agent.modelId)`），tds 只从个人 `~/.codex/config.toml` 继承 `model` / `model_provider` / `openai_base_url` / `model_providers`（`providerOverride`）；个人配置的其余键不进 agent 回合。
- 结论：agent 的 Codex 配置面就是 `~/.tds/codex-home/config.toml`，它是**每台机器一份**、本机所有走 Codex 运行时的 agent 共用。

## 2. 官方文档口径（OpenAI Docs）

来源：<https://developers.openai.com/codex/config-reference>（`.md` 版）、<https://developers.openai.com/codex/config-advanced>。

- `model_context_window`（number）：*Context window tokens available to the active model.* 顶层键。
- `model_auto_compact_token_limit`（number）：*Token threshold that triggers automatic history compaction (unset uses model defaults).*
- `model_auto_compact_token_limit_scope`（`total` | `body_after_prefix`，默认 `total`）：阈值按整段上下文计，还是只按携带前缀之后的增量计。
- 顶层键里**没有**按模型设置上下文或压缩阈值的表；`[models.*]` 只存在 `models.new_thread`（新会话默认模型 / 思考档 / 服务档）。
- 配置档：只有传 `--profile <name>` 时才会叠加 `$CODEX_HOME/<name>.config.toml`；tds 不传 `--profile`，所以 profile 文件不会被选中。
- `model_catalog_json`：指向**整份**模型目录 JSON（启动时加载）。实测是**整体替换而非合并**：只放 1 个模型时 `codex debug models` 只返回 1 个模型（见 §5）。
- `model_providers.<id>.*` 的字段里没有上下文窗口，只有 `base_url` / `model_catalog_url` / `wire_api` / 鉴权与传输等。

## 3. 修改前的值

| 项 | gpt-6-astra | gpt-6.1-sol |
| --- | --- | --- |
| 目录 `context_window` | 272000 | 500000 |
| 目录 `max_context_window` | 872000 | 872000 |
| 目录 `effective_context_window_percent` | 95 | 95 |
| 实际生效窗口（rollout 记录） | **258400** | **475000** |
| `model_auto_compact_token_limit` | 未配置（用模型默认） | 未配置（用模型默认） |

- 目录来源：`~/.tds/codex-home/models_cache.json`（与 `codex debug models` 同源）。
- 生效窗口来源：`~/.tds/codex-home/sessions/**/*.jsonl` 里每回合的 `"model_context_window"`；Astra 最近一回合 2026-10-28 10:13 记录 258400，sol 最近一回合 2026-10-27 21:43 记录 475000。
- 当前 `~/.tds/codex-home/config.toml`（sha256 `fc121ea10f7e710445fb29637fb048b5a33db8383ff4bd66d7a8870a4e5578df`）只有：

  ```toml
  # Written by tds. The agent's Codex home: only auth.json and your model provider are shared with your own ~/.codex.
  [features]
  apps = false

  [apps._default]
  enabled = false
  ```

  两个目标键都不存在。

## 4. 实测：700000 的语义（隔离环境）

在独立的临时 `CODEX_HOME`（`/tmp/codex-astra-verify`，只链接同一份 `auth.json`，不影响 agent home）写入：

```toml
model_context_window = 700000
model_auto_compact_token_limit = 500000
```

跑一次极小调用 `codex exec -m gpt-6-astra "Reply with exactly: OK"`，其 rollout 记录：

```json
"model_context_window": 665000
```

即 `model_context_window` 设置的是**原始窗口**，Codex 对外使用/上报的**有效窗口 = 原始 × 95%**（`effective_context_window_percent`）。所以用户口径的 700000 对应有效 665000。

## 5. 为什么不能只改 Astra

- 全局键（§2）：一改就是整个 `CODEX_HOME`，无法按模型区分。
- 配置档（§2）：只有 `--profile` 才会加载，tds 不传，改了也不生效；除非改启动器，属于需长期维护的补丁。
- 目录覆盖（§2）：`model_catalog_json` 整体替换目录。实测把目录里只留 `gpt-6-astra` 一项时，`codex debug models` 只返回 1 个模型。要只改 Astra，必须冻结**整份**目录副本——代价是新模型不会出现、每个模型的系统提示（`model_messages`）停在冻结当天，需要长期重新生成。
- 环境变量：`codex` 二进制里的 `CODEX_*` 环境变量没有上下文窗口或配置覆盖入口，所以也无法靠「只给某些 agent 注入密钥」来按 agent 区分。

## 6. 影响范围（若采用全局）

- `~/.tds/codex-home` 是本机所有 Codex 运行时 agent 共用的 home。
- 近两天该 home 的 rollout 里，`gpt-6-astra` 出现 1138 次、`gpt-6.1-sol` 出现 227 次（按文件内 `"model"` 字段去重统计）；sol 最后一次使用是 2026-10-27 21:43。
- 目录里所有模型的 `max_context_window` 都是 872000，700000 未超过任何模型的硬上限。
- 采用全局后：Astra 有效窗口 258400 → 665000、压缩点 500000；sol 有效窗口 475000 → 665000、压缩点从默认变为 500000。由于压缩阈值就是 500000（等于 sol 的标称窗口），sol 的实际上下文不会超过 500000，风险有限，但这是用户未点名模型的行为变化。

## 7. 生效时机

- Codex app-server 每次启动（即每个回合）重新读取 `config.toml`；**不需要重启机器、不需要重启 tds**。
- 正在执行的回合不受影响（它已经读过配置），**下一回合起生效**。
- 已有会话的上下文不重建；新阈值在后续回合的 token 计数与压缩判断上生效。
- 三种状态要分清：文件已改（本文件记录的是否落地）→ 下一回合生效（配置层面）→ 本轮已生效（rollout 里 `model_context_window` 已变化才算证据）。

## 8. 验证方法（非破坏性）

1. 读回配置：`CODEX_HOME=~/.tds/codex-home /Users/sunny/.local/bin/codex doctor`，或直接读 `~/.tds/codex-home/config.toml`。
2. 目录与模型：`CODEX_HOME=~/.tds/codex-home /Users/sunny/.local/bin/codex debug models`（确认模型目录仍是完整的，没有被 `model_catalog_json` 替换）。
3. 生效证据：新回合结束后读该回合 rollout 的 `"model_context_window"`，Astra 应为 665000（此前 258400）。
4. 以上都不触碰正在运行的会话；不停止任务、不重启 tds。

## 9. 待决定（阻塞项）

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（推荐） | 在 `~/.tds/codex-home/config.toml` 追加 `model_context_window = 700000` 与 `model_auto_compact_token_limit = 500000` | 本机 Codex 的 sol 回合也一起变（§6）；零维护，删两行即恢复 |
| B | `model_catalog_json` 指向冻结的整份目录副本，只改 Astra | 目录被冻结：新模型不出现、模型系统提示停在冻结日；需长期重新生成 |
| C | 不改 | 维持现状（Astra 有效窗口 258400、压缩用默认） |

## 10. 变更记录

- 2026-10-28：完成调研、官方文档核对、修改前值取证与隔离实测（700000 → 有效 665000）；因只能全局生效，适用范围交用户决定，未落地任何修改。
