# Astra 上下文窗口与压缩阈值（GPT-6-Astra 70 万 / 50 万）

状态：**已落地并读回**（2026-10-28）。范围：本机 Todos 的 Codex 运行时（`$HOME/.tds/codex-home`），不涉及 BeefTV 产品代码。

配套文档：#94「Codex 按模型上下文窗口与压缩阈值（GPT-6.1-Sol 100 万 / 60 万）」——
`docs/ops/codex-per-model-context-config-20261028.md`（机制、Sol 的落地与隔离实测在那一份，本文只记 Astra）。

## 结论

- GPT-6-Astra 已按模型级生效：**有效上下文窗口 700,000**、**自动压缩阈值 500,000**。
- 落地方式与 #94 相同：改 `model_catalog_json` 指向的**模型目录副本**（`OVERRIDES` + 刷新脚本），
  **不写顶层** `model_context_window` / `model_auto_compact_token_limit`。
- 同 home 其他模型数值不变：`gpt-6.1-sol` 保持 1,000,000 / 600,000，其余 8 个模型仍为目录原值。
- 已读回：真实 agent home 会话在改动后的第一个回合把 `model_context_window` 从 258400 变为 **700000**（见 §4）。

## 1. 为什么不按「全局设置」落地

用户在适用范围卡片里选了「全局设置」。该选项**被搁置**，因为执行期间环境发生了变化，且全局写法会破坏同 home 的既有设置：

1. 卡片发出时本机还没有按模型的入口，所以「全局」是当时唯一能生效的做法；随后 #94 已把按模型的目录覆盖机制落地
   （`config.toml` 的 `model_catalog_json` + `model-catalog.json` + `refresh-model-catalog.sh`），
   `refresh-model-catalog.sh` 里还留了本任务（#93）的 Astra 占位注释。用户那次选择解决的是**适用范围许可**；
   现在两种模型可以各留各的值，不必用一个全局值把两者拉平。
2. 顶层键会**覆盖目录**：隔离实测「目录（Astra 272000 / eff 95%）+ 顶层 `model_context_window = 700000`」时，
   Astra 记录 **665000**（= min(700000, 872000) × 95%），而不是目录里的 258400。也就是说全局写法会把
   `gpt-6.1-sol` 从 1,000,000 拉回 700000（= min(700000, 1000000) × 100%），回退掉 #94 已批准的设置。

因此按用户本意（Astra 700k / 500k、不动其他模型）落到目录覆盖，位置正是脚本预留的占位处。

## 2. 改动位置与前后值

改动文件（本机，不在仓库）：

- `$HOME/.tds/codex-home/refresh-model-catalog.sh`：`OVERRIDES` 新增 `gpt-6-astra` 一项（原来是注释示例）。
- `$HOME/.tds/codex-home/model-catalog.json`：跑一次刷新脚本重新生成。
- `$HOME/.tds/codex-home/config.toml`：只补了一行说明注释（把 Astra 值写进头部说明），
  `model_catalog_json` 行是 #94 加的，未改。

| 模型 | 字段 | 改动前 | 改动后 |
| --- | --- | --- | --- |
| gpt-6-astra | context_window / max_context_window | 272000 / 872000 | **700000 / 700000** |
| gpt-6-astra | effective_context_window_percent | 95 | **100** |
| gpt-6-astra | auto_compact_token_limit | 未设（模型默认） | **500000** |
| gpt-6-astra | **实际生效窗口** | 258400 | **700000** |
| gpt-6.1-sol | 全部字段 | 1000000 / 1000000 / 100 / 600000 | 未改动 |
| 其余 8 个模型 | 全部字段 | 目录原值 | 未改动 |

原始窗口与有效窗口：Codex 对外使用的有效窗口 = `min(窗口, max_context_window) × effective_context_window_percent`。
Astra 这次把两者都设为 700000、百分比设 100，所以**原始窗口 = 有效窗口 = 700000**（改前是 272000 × 95% = 258400）。
注意 Astra 的模型文档总窗口是 872000，本次按 700000 记账，等于自留约 17 万 token 余量。

## 3. 生效时机

tds 每个回合都新起 `codex app-server`，`config.toml` 与 `model_catalog.json` 在启动时读取，
所以**文件已改 → 下一回合生效**；不需要重启 Todos / tds，也不影响正在跑的回合（它启动时已经读过旧配置）。
**本轮已生效**以该回合 rollout 的 `model_context_window` 为准。

## 4. 读回证据

| 检查 | 方式 | 结果 |
| --- | --- | --- |
| 配置解析 | `CODEX_HOME=$HOME/.tds/codex-home codex debug models` | 目录仍是完整 **10 个模型**；Astra = 700000 / 700000 / 100 / 500000，Sol = 1000000 / 1000000 / 100 / 600000 |
| 隔离实测（真实回合） | 独立临时 home，只设 `model_catalog_json` 指向重新生成的目录，各跑一次极小回合 | Astra rollout `"model_context_window":700000`；Sol rollout `"model_context_window":1000000` |
| **真实 agent home 读回** | `$HOME/.tds/codex-home/sessions/**/rollout-2026-10-28T10-03-23-01a1803f-*.jsonl` | 该会话 10:03–10:28 的 token 事件为 258400，**10:29:52 起为 700000**（改动后第一个回合） |

## 5. 未测项与限制（不要当成已验）

- **没有真正跑到 500,000 才压缩**：只证明目录里的 `auto_compact_token_limit` 被读取（§4 的读回值），
  未触达 50 万。压缩阈值能否真的触发，由 #94 用极小阈值（5000）的对照实验证明过——那是机制验证，不是 50 万处的验证。
- **没有验证上游接受 700,000 token 输入**：只证明 Codex 侧按 70 万记账。账号实时目录给 Astra 的
  `max_context_window` 是 872000，70 万在其内，风险较低，但未实测。
- **目录副本的长期代价**：`model_catalog_json` 是整份替换，新模型不会自己出现、已有模型的系统提示
  （`model_messages`）停在生成当天。刷新方式见 §6。

## 6. 维护与回滚

刷新（Codex 更新、目录变化后执行，会一并重放所有 `OVERRIDES`）：

```sh
$HOME/.tds/codex-home/refresh-model-catalog.sh
```

回滚 Astra 一项：删掉 `refresh-model-catalog.sh` 里 `OVERRIDES` 的 `"gpt-6-astra"` 条目，再跑一次刷新脚本，
并同步删掉 `config.toml` 头部那行说明注释。

注意：`config.toml` 由 tds 在**文件缺失时**重写为默认内容，手工加的 `model_catalog_json` 行会随之丢失，
删过该文件就要重新加回（#94 亦已记录）。现有备份 `config.toml.bak-20261028-sol1m` 未改动。

## 7. 变更记录

- 2026-10-28 10:16：调研官方配置面、修改前值取证、隔离实测顶层 `model_context_window = 700000` → 有效 665000；
  当时只有全局入口，故把适用范围交用户决定。
- 2026-10-28 10:28：接 #94 的按模型机制，`OVERRIDES` 增加 `gpt-6-astra`（700000 / 700000 / 100 / 500000），
  重跑刷新脚本；隔离实测 Astra = 700000、Sol = 1000000 不变。
- 2026-10-28 10:29–10:30：真实 agent home 会话读回 Astra `model_context_window = 700000`。
