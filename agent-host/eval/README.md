# BeefTV 内置创作助手评测台 (`agent-host/eval/`)

本目录提供独立、确定性、零外部生成扣费的内置创作助手评测台（Evaluation Harness）。通过内存版 Go 业务权威模拟器（`sim-go.mjs`）与 6 个固定真实创作场景（`scenarios.mjs`），驱动真实的 `agent-host/server.mjs`（Durable SQLite 会话、操作桥、画布 CAS 与技能加载）执行端到端回归评测。

---

## 1. 目录结构

- `sim-go.mjs`：内存版 Go 业务权威模拟器（`createSimGo`）。加载真实的 `operation-descriptors.fixture.json`，支持 `/api/ops`、`/api/ops/:id`、`/api/canvas`、`/api/canvas/operations`、`/api/assistant/runtime/turns/:id`、`/api/assistant/turns`、`/api/assistant/skills`、`/api/assistant/skills/active`、`/api/assistant/runtime/canvases/:id/skill-context` 与 `/api/generation-tasks`。
- `scenarios.mjs`（及 `scenarios/index.mjs`）：6 个固定评测场景定义、确定性检查项（`checks`）与本地 Fake OpenAI Chat Completions SSE 模型桩（`createFakeModelServer`）。
- `run-eval.mjs`：CLI 评测运行器、预算门禁与成本计量器（`createCostMeter`）、密钥脱敏器（`redactSecrets`）与 JSON/Markdown 报告生成器。
- `sim-go.test.mjs`：针对 `sim-go`、CAS 冲突、分镜行产出连线绑定、生成提议与撤销、预算熔断及脱敏的单测与端到端套件。

---

## 2. 快速运行

### 运行模拟器与评测核心单测
```bash
cd agent-host
bun test eval/sim-go.test.mjs
```

### 运行全量 6 场景确定性评测（默认 `--model fake`，零付费调用）
```bash
cd agent-host
bun eval/run-eval.mjs --model fake
```

### 指定单场景与自定义输出目录
```bash
cd agent-host
bun eval/run-eval.mjs --scenario S1,S2 --model fake --runs 1 --out /tmp/beeftv-eval-report
```

### 运行真实模型评测（需显式配置非零单价与预算上限）
```bash
cd agent-host
BEEFTV_AGENT_BASE_URL="https://your-provider.example.com/v1" \
BEEFTV_AGENT_API_KEY="sk-..." \
BEEFTV_AGENT_MODEL="your-model-id" \
BEEFTV_EVAL_PRICE_IN="2.0" \
BEEFTV_EVAL_PRICE_OUT="8.0" \
bun eval/run-eval.mjs --model real --scenario all --runs 3 --max-requests 25 --budget-cny 25 --out /tmp/beeftv-real-eval
```

---

## 3. CLI 参数与环境变量

### CLI 参数
| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--scenario <id\|all>` | `all` | 场景标识（支持 `S1`..`S6` 或 `shortdrama-2shot` 等名称，支持逗号分隔） |
| `--model <fake\|real>` | `fake` | `fake` 使用本地确定性 SSE 模型服务；`real` 连接真实模型并启用本地计量代理 |
| `--runs <N>` | `1` | 每个场景重复运行次数（`1..50`） |
| `--max-requests <N>` | `25` | 注入 `BEEFTV_AGENT_MAX_REQUESTS_PER_TURN` 的单轮最大模型请求上限 |
| `--budget-cny <number>` | `25` | 整轮评测累计人民币预算上限，超限立即中断并标记 `aborted_budget` |
| `--out <dir>` | 临时目录 | 输出 `report.json`、`report.md` 与 `ledger.jsonl` 的目录路径 |

### 环境变量（`--model real` 必填）
- `BEEFTV_EVAL_PRICE_IN`：输入价格（人民币元 / 百万 token，必须 `> 0`）
- `BEEFTV_EVAL_PRICE_OUT`：输出价格（人民币元 / 百万 token，必须 `> 0`）
- `BEEFTV_AGENT_BASE_URL`：模型服务 Base URL
- `BEEFTV_AGENT_API_KEY`：模型 API Key（写入报告与账本前自动脱敏为 `[REDACTED]`）
- `BEEFTV_AGENT_MODEL`：模型 ID
- `BEEFTV_AGENT_API`：协议类型（默认 `openai-completions`）

---

## 4. 固定评测场景一览（S1–S6）

| 编号 | 场景 ID | 核心验证目标 | 基线预期 |
| :--- | :--- | :--- | :--- |
| **S1** | `shortdrama-2shot` | 空画布创建 2 镜短剧开场：分镜脚本节点、2 行完整分镜、2 首帧图节点、2 视频节点、`image->video` 连线、零悬空媒体节点 | `PASS` |
| **S2** | `storyboard-8shot` | 写满 8 镜分镜表，只为前 2 镜创建首帧图节点并回填 `imageNodeId`，第 3–8 镜不越界建节点 | `PASS` |
| **S3** | `local-edit` | 预置 4 镜画布，只改第 3 镜描述与第 3 首帧图提示词，断言第 1/2/4 镜与其余节点、连线 100% 未动 | `PASS` |
| **S4** | `mid-turn-steer` | 首轮模型请求期间通过 `/steer` 注入改向（古风武侠 4 镜 -> 赛博朋克霓虹夜市 2 镜），同轮收敛完成 | `PASS` |
| **S5** | `post-generation-review` | 提交生成提议后模拟器交付带六指缺陷的图片，检验自动唤醒复查能力（标注 `wake-on-generation` 能力缺口） | `GAP (expected)` |
| **S6** | `skill-after-compaction` | 激活「短剧分镜到首帧」技能后连续 4 轮长上下文对话，第 4 轮物化首帧仍遵守命名、9:16 画幅、`imageNodeId` 回填与提议门禁 | `PASS` |

---

## 5. 核心守护指标说明

1. **结构完整率 (`structuralCompletenessRate`)**：场景内通过的结构化断言数 / 总断言数。
2. **生成门禁合规 (`unconfirmedGenerationCount` / `duplicateNodeCount` / `duplicateProposalCount`)**：
   - 未经用户确认直接触发付费生成的任务数必须为 `0`。
   - 同一画布重复创建同名节点数、同一未失败节点重复提议次数。
3. **效率与成本 (`efficiency`)**：回合数、模型请求次数、读写操作数、输入/输出 Token、人民币花费与耗时。
4. **CAS 冲突恢复率 (`conflictRecoveryRate`)**：遭遇 `revision_conflict` 后通过重读最新画布恢复成功的比例。
5. **多轮技能保持率 (`skillRetentionRate`)**：在 S6 多轮长对话后，技能步骤硬性约束的保持率。

---

## 6. 已知限制与扩展方式

- **S5 自动唤醒缺口 (`wake-on-generation`)**：当前 baseline 宿主尚未内置异步生成任务完成后的自动唤醒回路，评测台将其如实记录为 `baseline_gap`（`capabilityGap: "wake-on-generation"`），待后续自动唤醒链路接入后将自动转为 `PASS`。
- **新增场景**：在 `scenarios.mjs` 的 `SCENARIOS` 数组中追加包含 `id`、`code`、`setup`、`turns` 与 `evaluate` 的场景定义即可自动纳入 `--scenario all`。
