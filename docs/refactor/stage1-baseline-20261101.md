# 阶段 1：内置创作助手性能与往返基线报告（2026-11-01）

本报告基于阶段 0（PR #354，`86a7b119`，固定头部 `instructions` + `<available_skills>`、画布摘要 `<beeftv_studio>` 与 `<beeftv_plan>` 移至请求末尾）合入后的主线，通过评测台（`agent-host/eval/run-eval.mjs`）加真实运行（`deepseek-v4.1-flash`）导出 **S1–S7 全场景每句话请求次数、每轮工具调用序列、每次请求的 Token、缓存命中率、耗时**，并逐笔标出可以省掉的往返。这份基线是阶段 2 新轻量宿主要超过的目标。

---

## 1. 总体基线与新宿主超越目标（`deepseek-v4.1-flash`）

- **运行命令**：
  ```bash
  cd agent-host
  bun eval/run-eval.mjs --model real --scenario all --runs 1 --max-requests 20 --budget-cny 5.0
  ```
- **预算消耗**：完整跑通 S1–S7 共花费 **¥1.4680**（加上代理修复前 11 笔单跳请求 ¥0.1979，阶段 1 合计花费 **¥1.6659**，控制在 ≤ ¥10 预算内）。

| 指标维度 | 当前基线 (`deepseek-v4.1-flash`) | 阶段 2 新宿主目标 |
| :--- | :--- | :--- |
| **场景通过数（S1–S7）** | **6 通过 / 1 已知缺口 (`S5 wake-on-generation`) / 0 失败** | 保持 **≥ 6 通过 / 0 失败** |
| **平均结构完整率** | **92.9%**（S1/S2/S3/S4/S6/S7 均为 100%） | **≥ 92.9%** |
| **安全与正确性门禁** | 未确认付费生成 `0` / 重复节点 `0` / 未恢复 CAS 冲突 `0` / S6 技能保持率 `100%` | 全部保持 **`0` 违规 / `100%` 保持** |
| **总用户句数 / 总模型请求数** | `11` 句 / **`56` 次请求**（平均 **`5.09` 次/句**） | **≤ `30` 次请求**（平均 **≤ `2.73` 次/句**，省去 26 次往返） |
| **总输入 Token / 缓存命中 Token** | 输入 **`1,263,432` tok** / 命中 **`1,172,864` tok** | 随请求轮次减少总输入降至 **≤ `650,000` tok** |
| **整体缓存命中率 (`cached_tokens`)** | **`92.8%`**（未命中输入仅 `90,568` tok） | **≥ `90%`** |
| **头部 + 工具定义体积** | 头部 `9,611` 字符 + 40 工具 `34,024` 字符 = **`43,635` 字符** | 显著缩减指令与工具描述体积 |
| **总输出 Token** | **`51,141` tok** | **≤ `35,000` tok**（消除报错作废输出與冗余计划输出） |
| **总耗时 (`durationMs`)** | **`381,297 ms`**（平均 **`34.7 s/句`**） | **≤ `220,000 ms`**（平均 **≤ `20 s/句`**） |
| **单轮全集费用（按 输入¥1/M、输出¥4/M）** | **`¥1.4680`** | **≤ `¥0.85`** |

---

## 2. 分场景指标总览（S1–S7 真模型实测）

| 场景 | 状态 | 检查项 | 句数 / 请求数 (可省) | 读/写操作 | 输入 Token (缓存命中%) | 输出 Token | 费用 (¥) | 耗时 (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **S1** `shortdrama-2shot` | PASS | 6/6 | 1 句 / **7 次** (可省 4) | 41 / 10 | 159,021 (**91.0%**) | 9,282 | 0.1961 | 63,891 |
| **S2** `storyboard-8shot` | PASS | 4/4 | 1 句 / **9 次** (可省 6) | 28 / 7 | 225,026 (**91.3%**) | 12,605 | 0.2754 | 84,932 |
| **S3** `local-edit` | PASS | 5/5 | 1 句 / **3 次** (可省 0) | 10 / 2 | 54,870 (**91.2%**) | 1,654 | 0.0615 | 13,092 |
| **S4** `mid-turn-steer` | PASS | 4/4 | 1 句 / **7 次** (可省 4) | 37 / 6 | 155,282 (**92.2%**) | 8,029 | 0.1874 | 54,755 |
| **S5** `post-generation-review` | GAP (expected) | 1/2 | 1 句 / **4 次** (可省 1) | 14 / 2 | 67,663 (**95.0%**) | 1,438 | 0.0734 | 14,540 |
| **S6** `skill-across-turns` | PASS | 5/5 | 4 句 / **16 次** (可省 7) | 83 / 11 | 415,524 (**93.4%**) | 14,901 | 0.4751 | 117,710 |
| **S7** `user-requested-generation-review` | PASS | 3/3 | 2 句 / **10 次** (可省 4) | 31 / 3 | 186,046 (**95.0%**) | 3,232 | 0.1990 | 32,377 |
| **合计** | **6 PASS / 1 GAP** | **28/29** | **11 句 / 56 次 (可省 26)** | **244 / 41** | **1,263,432 (92.8%)** | **51,141** | **1.4680** | **381,297** |

---

## 3. 每句话请求次数、工具调用序列与耗时汇总（11 句）

| 场景 / 回合 | 用户指令摘要 | 请求数 (可省 -> 目标) | 耗时 (ms) | 输入 Token (缓存命中%) | 输出 Token | 工具调用序列（按请求展开） |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **S1** `turn-s1-1` | 都市短剧开场 2 镜脚本+首帧+视频+连线 | **7** (-4 -> **3**) | 63,889 | 159,021 (91.0%) | 9,282 | `R1:skill_load+canvas_get+model_catalog` → `R2:plan_update+canvas_script_prepare` → `R3:plan_update+canvas_nodes_create[可省]` → `R4:canvas_script_rows_append+canvas_node_configure×4[可省]` → `R5:canvas_script_row_update+canvas_edge_create×2[可省]` → `R6:plan_update+canvas_generation_propose` → `R7:<reply>[可省]` |
| **S2** `turn-s2-1` | 30 秒科幻预告片 8 镜分镜表，只建前 2 镜首帧 | **9** (-6 -> **3**) | 84,930 | 225,026 (91.3%) | 12,605 | `R1:canvas_get+model_catalog+plan_update` → `R2:canvas_script_prepare` → `R3:canvas_nodes_create[可省]` → `R4:canvas_script_rows_append[可省]` → `R5:canvas_nodes_create[可省]` → `R6:canvas_node_configure×2[可省]` → `R7:canvas_script_row_update[可省]` → `R8:plan_update[可省]` → `R9:<reply>` |
| **S3** `turn-s3-1` | 只把第 3 镜画面改成清晨薄雾森林并更新首帧图提示词 | **3** (-0 -> **3**) | 13,084 | 54,870 (91.2%) | 1,654 | `R1:canvas_get` → `R2:canvas_script_row_update+canvas_node_update` → `R3:<reply>` |
| **S4** `turn-s4-1` | 规划 4 镜古风武侠开场 + 途中 `/steer` 改赛博夜市 2 镜 | **7** (-4 -> **3**) | 54,753 | 155,282 (92.2%) | 8,029 | `R1:skill_load+canvas_get+model_catalog` → `R2:canvas_script_prepare` → `R3:canvas_nodes_create[可省]` → `R4:canvas_script_rows_append[可省]` → `R5:canvas_node_configure×2+canvas_script_row_update[可省]` → `R6:plan_update[可省]` → `R7:canvas_generation_propose` |
| **S5** `turn-s5-1` | 创建特写人像首帧图节点并提交生成提议 | **4** (-1 -> **3**) | 13,520 | 67,663 (95.0%) | 1,438 | `R1:canvas_get+model_catalog` → `R2:canvas_nodes_create` → `R3:canvas_node_configure+plan_update[可省]` → `R4:canvas_generation_propose` |
| **S6** `turn-s6-1` | 选「短剧分镜到首帧」技能，写雨夜天台对峙角色与 2 镜分镜 | **6** (-4 -> **2**) | 34,309 | 116,412 (94.2%) | 3,962 | `R1:canvas_get+plan_update[可省]` → `R2:plan_update[可省]` → `R3:canvas_nodes_create` → `R4:canvas_script_rows_append[可省]` → `R5:plan_update[可省]` → `R6:<reply>` |
| **S6** `turn-s6-2` | 补充林晚调查失踪案背景，同步更新角色设定与两镜台词 | **2** (-0 -> **2**) | 27,384 | 47,782 (87.3%) | 3,689 | `R1:canvas_node_update+canvas_script_row_update` → `R2:<reply>` |
| **S6** `turn-s6-3` | 补充天台积水红霓虹与冷蓝主光到角色和两镜描述 | **2** (-0 -> **2**) | 24,645 | 55,866 (91.0%) | 3,376 | `R1:canvas_node_update+canvas_script_row_update` → `R2:<reply>` |
| **S6** `turn-s6-4` | 分镜确认，开始准备两个镜头的首帧 | **6** (-3 -> **3**) | 31,367 | 195,464 (95.2%) | 3,874 | `R1:model_catalog+plan_update` → `R2:canvas_script_prepare` → `R3:canvas_nodes_create[可省]` → `R4:canvas_node_configure×2[可省]` → `R5:canvas_script_row_update+plan_update[可省]` → `R6:canvas_generation_propose` |
| **S7** `turn-s7-1` | 创建特写人像首帧图节点并提交生成提议 | **5** (-2 -> **3**) | 15,054 | 86,049 (94.6%) | 1,560 | `R1:canvas_get+model_catalog` → `R2:plan_update+canvas_nodes_create` → `R3:canvas_node_configure[可省]` → `R4:plan_update+canvas_generation_propose` → `R5:<reply>[可省]` |
| **S7** `turn-s7-2` | 复查刚生成的画面，改提示词并重新给生成提议 | **5** (-2 -> **3**) | 17,307 | 99,997 (95.4%) | 1,672 | `R1:media_overview` → `R2:media_inspect` → `R3:canvas_node_update` → `R4:plan_update+canvas_generation_propose[可省]` → `R5:<reply>[可省]` |

---

## 4. 每次模型请求逐笔明细与可省往返标注（共 56 次）

| 全局# | 场景 / 回合 | 触发原因 (上步结果) | 本次响应动作 / 工具调用 | 输入 Token | 缓存命中 (占比) | 输出 Token | 耗时 (ms) | 可省往返标注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| #1 | **S1** `turn-s1-1` R1 | `user_message` | `skill_load` + `canvas_get` + `model_catalog`(caps=[image,video]) | 15,828 | 15,744 (99.5%) | 358 | 4,327 | 保留（注：其中 `canvas_get` 在空画布上冗余，但同批有 `skill_load`+`model_catalog`） |
| #2 | **S1** `turn-s1-1` R2 | `tool_result` | `plan_update` + `canvas_script_prepare`(newScript, rows=2) | 17,466 | 15,744 (90.1%) | 3,798 | 26,166 | 保留（尝试调用复合操作一次准备脚本+2行+首帧+视频+连线，因 `sim-go` 未实现返回报错） |
| #3 | **S1** `turn-s1-1` R3 | `tool_error_result` (`canvas_script_prepare:ERR`) | `plan_update` + `canvas_nodes_create`(nodes=5[script,image×2,video×2]) | 21,336 | 17,408 (81.6%) | 1,146 | 6,611 | **可省**: 工具报错回退重试 (`canvas_script_prepare:unsupported_operation`) |
| #4 | **S1** `turn-s1-1` R4 | `tool_result` | `canvas_script_rows_append`(rows=2) + `canvas_node_configure`×4 | 23,194 | 21,248 (91.6%) | 2,447 | 12,292 | **可省**: 串行分步改画布（R2 `canvas_script_prepare` 成功后无需此步） |
| #5 | **S1** `turn-s1-1` R5 | `tool_result` | `canvas_script_row_update`(patches=2) + `canvas_edge_create`×2 | 26,331 | 22,528 (85.6%) | 377 | 3,441 | **可省**: 串行分步改画布（R2 `canvas_script_prepare` 成功后无需此步） |
| #6 | **S1** `turn-s1-1` R6 | `tool_result` | `plan_update` + `canvas_generation_propose`(kind=image, nodeIds=[node-2,node-3]) | 26,840 | 25,728 (95.9%) | 791 | 5,885 | 保留 |
| #7 | **S1** `turn-s1-1` R7 | `tool_result` | `<final_reply>` | 28,026 | 26,368 (94.1%) | 365 | 3,896 | **可省**: `plan_update` 与 `generation_propose` 同批调用导致 `terminate` 未生效，多一次总结请求 |
| #8 | **S2** `turn-s2-1` R1 | `user_message` | `canvas_get` + `model_catalog`(caps=[image]) + `plan_update` | 15,821 | 15,744 (99.5%) | 816 | 5,454 | 保留 |
| #9 | **S2** `turn-s2-1` R2 | `tool_result` | `canvas_script_prepare`(newScript, rows=8) | 17,411 | 15,744 (90.4%) | 5,138 | 36,975 | 保留 |
| #10 | **S2** `turn-s2-1` R3 | `tool_error_result` (`canvas_script_prepare:ERR`) | `canvas_nodes_create`(nodes=1[script]) | 22,589 | 16,384 (72.5%) | 395 | 3,228 | **可省**: 工具报错回退重试 (`canvas_script_prepare:unsupported_operation`) |
| #11 | **S2** `turn-s2-1` R4 | `tool_result` | `canvas_script_rows_append`(nodeId=node-6, rows=8) | 23,089 | 22,272 (96.5%) | 4,494 | 19,170 | **可省**: 串行分步改画布 |
| #12 | **S2** `turn-s2-1` R5 | `tool_result` | `canvas_nodes_create`(nodes=2[image×2]) | 28,107 | 22,784 (81.1%) | 432 | 3,293 | **可省**: 串行分步改画布 |
| #13 | **S2** `turn-s2-1` R6 | `tool_result` | `canvas_node_configure`×2(node-7, node-8) | 28,718 | 27,392 (95.4%) | 482 | 3,642 | **可省**: 串行分步改画布 |
| #14 | **S2** `turn-s2-1` R7 | `tool_result` | `canvas_script_row_update`(nodeId=node-6, patches=2) | 29,465 | 27,904 (94.7%) | 141 | 1,961 | **可省**: 串行分步改画布 |
| #15 | **S2** `turn-s2-1` R8 | `tool_result` | `plan_update` | 29,637 | 28,672 (96.7%) | 374 | 5,104 | **可省**: 单独调用 `plan_update` 占一整轮请求 |
| #16 | **S2** `turn-s2-1` R9 | `tool_result` | `<final_reply>` | 30,189 | 28,672 (95.0%) | 333 | 3,723 | 保留 |
| #17 | **S3** `turn-s3-1` R1 | `user_message` | `canvas_get` | 16,078 | 16,000 (99.5%) | 469 | 3,726 | 保留（需读取分镜行完整文本与 rowId） |
| #18 | **S3** `turn-s3-1` R2 | `tool_result` | `canvas_script_row_update`(patches=1) + `canvas_node_update`(node-img-3) | 18,820 | 15,616 (83.0%) | 940 | 6,343 | 保留（同批修改分镜行与首帧图节点） |
| #19 | **S3** `turn-s3-1` R3 | `tool_result` | `<final_reply>` | 19,972 | 18,432 (92.3%) | 245 | 2,828 | 保留 |
| #20 | **S4** `turn-s4-1` R1 | `user_message` | `skill_load` + `canvas_get` + `model_catalog`(caps=[image,video]) | 15,801 | 15,744 (99.6%) | 509 | 3,984 | 保留 |
| #21 | **S4** `turn-s4-1` R2 | `user_steer` | `canvas_script_prepare`(newScript(赛博夜市开场 2 镜, rows=2)) | 17,639 | 15,744 (89.3%) | 4,661 | 30,394 | 保留（收到 steer 改向后一步生成 2 镜） |
| #22 | **S4** `turn-s4-1` R3 | `tool_error_result` (`canvas_script_prepare:ERR`) | `canvas_nodes_create`(nodes=3[script,image×2]) | 22,340 | 17,536 (78.5%) | 667 | 4,569 | **可省**: 工具报错回退重试 (`canvas_script_prepare:unsupported_operation`) |
| #23 | **S4** `turn-s4-1` R4 | `tool_result` | `canvas_script_rows_append`(nodeId=node-9, rows=2) | 23,212 | 22,272 (96.0%) | 1,295 | 6,688 | **可省**: 串行分步改画布 |
| #24 | **S4** `turn-s4-1` R5 | `tool_result` | `canvas_node_configure`×2 + `canvas_script_row_update`(patches=2) | 24,685 | 23,040 (93.3%) | 457 | 3,110 | **可省**: 串行分步改画布 |
| #25 | **S4** `turn-s4-1` R6 | `tool_result` | `plan_update` | 25,428 | 24,320 (95.6%) | 304 | 3,096 | **可省**: 单独调用 `plan_update` 占一整轮请求 |
| #26 | **S4** `turn-s4-1` R7 | `tool_result` | `canvas_generation_propose`(kind=image, nodeIds=[node-10,node-11]) | 26,177 | 24,576 (93.9%) | 136 | 2,224 | 保留（单独调用 `generation_propose` 触发 `control.terminate` 直接结束） |
| #27 | **S5** `turn-s5-1` R1 | `user_message` | `canvas_get` + `model_catalog`(caps=[image]) | 15,809 | 15,744 (99.6%) | 326 | 3,223 | 保留 |
| #28 | **S5** `turn-s5-1` R2 | `tool_result` | `canvas_nodes_create`(nodes=1[image:特写人像首帧]) | 16,546 | 15,744 (95.2%) | 581 | 4,805 | 保留 |
| #29 | **S5** `turn-s5-1` R3 | `tool_result` | `canvas_node_configure`(node-12) + `plan_update` | 17,216 | 16,384 (95.2%) | 361 | 2,982 | **可省**: 串行分步改画布（创建节点时即可带入 model/size/count 或与 propose 合并） |
| #30 | **S5** `turn-s5-1` R4 | `tool_result` | `canvas_generation_propose`(kind=image, nodeIds=[node-12]) | 18,092 | 16,384 (90.6%) | 170 | 2,296 | 保留 |
| #31 | **S6** `turn-s6-1` R1 | `user_message` | `canvas_get` + `plan_update` | 16,701 | 16,640 (99.6%) | 1,325 | 9,693 | **可省**: 空画布已有 `<beeftv_studio>` 现场摘要仍调用 `canvas_get` |
| #32 | **S6** `turn-s6-1` R2 | `tool_result` | `plan_update` | 18,219 | 16,640 (91.3%) | 256 | 2,345 | **可省**: 单独调用 `plan_update` 占一整轮请求 |
| #33 | **S6** `turn-s6-1` R3 | `tool_result` | `canvas_nodes_create`(nodes=2[markdown:角色设定,script:分镜脚本]) | 18,934 | 18,176 (96.0%) | 532 | 5,122 | 保留 |
| #34 | **S6** `turn-s6-1` R4 | `tool_result` | `canvas_script_rows_append`(nodeId=node-14, rows=2) | 19,672 | 18,560 (94.3%) | 1,315 | 10,381 | **可省**: 串行分步改画布 |
| #35 | **S6** `turn-s6-1` R5 | `tool_result` | `plan_update` | 21,168 | 19,200 (90.7%) | 318 | 2,944 | **可省**: 单独调用 `plan_update` 占一整轮请求 |
| #36 | **S6** `turn-s6-1` R6 | `tool_result` | `<final_reply>` | 21,718 | 20,480 (94.3%) | 216 | 3,092 | 保留 |
| #37 | **S6** `turn-s6-2` R1 | `user_message` | `canvas_node_update`(node-13) + `canvas_script_row_update`(node-14, patches=2) | 22,109 | 21,120 (95.5%) | 3,225 | 22,851 | 保留 |
| #38 | **S6** `turn-s6-2` R2 | `tool_result` | `<final_reply>` | 25,673 | 20,608 (80.3%) | 464 | 4,204 | 保留 |
| #39 | **S6** `turn-s6-3` R1 | `user_message` | `canvas_node_update`(node-13) + `canvas_script_row_update`(node-14, patches=2) | 26,303 | 25,088 (95.4%) | 2,913 | 19,663 | 保留 |
| #40 | **S6** `turn-s6-3` R2 | `tool_result` | `<final_reply>` | 29,563 | 25,728 (87.0%) | 463 | 4,811 | 保留 |
| #41 | **S6** `turn-s6-4` R1 | `user_message` | `model_catalog`(caps=[image]) + `plan_update` | 30,172 | 29,056 (96.3%) | 766 | 5,880 | 保留 |
| #42 | **S6** `turn-s6-4` R2 | `tool_result` | `canvas_script_prepare`(nodeId=node-14, rows=2) | 31,419 | 29,568 (94.1%) | 454 | 4,353 | 保留 |
| #43 | **S6** `turn-s6-4` R3 | `tool_error_result` (`canvas_script_prepare:ERR`) | `canvas_nodes_create`(nodes=2[image:镜1 首帧,image:镜2 首帧]) | 31,913 | 30,720 (96.3%) | 1,070 | 8,315 | **可省**: 工具报错回退重试 (`canvas_script_prepare:unsupported_operation`) |
| #44 | **S6** `turn-s6-4` R4 | `tool_result` | `canvas_node_configure`×2(node-15, node-16) | 33,132 | 31,360 (94.7%) | 445 | 3,972 | **可省**: 串行分步改画布 |
| #45 | **S6** `turn-s6-4` R5 | `tool_result` | `canvas_script_row_update`(node-14, patches=2) + `plan_update` | 33,825 | 32,512 (96.1%) | 903 | 5,106 | **可省**: 串行分步改画布 |
| #46 | **S6** `turn-s6-4` R6 | `tool_result` | `canvas_generation_propose`(kind=image, nodeIds=[node-15,node-16]) | 35,003 | 32,768 (93.6%) | 236 | 3,314 | 保留 |
| #47 | **S7** `turn-s7-1` R1 | `user_message` | `canvas_get` + `model_catalog`(caps=[image]) | 15,796 | 15,744 (99.7%) | 138 | 1,566 | 保留 |
| #48 | **S7** `turn-s7-1` R2 | `tool_result` | `plan_update` + `canvas_nodes_create`(nodes=1[image:特写人像首帧]) | 16,345 | 15,744 (96.3%) | 810 | 6,055 | 保留 |
| #49 | **S7** `turn-s7-1` R3 | `tool_result` | `canvas_node_configure`(node-17) | 17,545 | 16,256 (92.7%) | 220 | 2,255 | **可省**: 串行分步改画布 |
| #50 | **S7** `turn-s7-1` R4 | `tool_result` | `plan_update` + `canvas_generation_propose`(kind=image, nodeIds=[node-17]) | 17,891 | 16,384 (91.6%) | 268 | 2,499 | 保留 |
| #51 | **S7** `turn-s7-1` R5 | `tool_result` | `<final_reply>` | 18,472 | 17,280 (93.5%) | 124 | 2,385 | **可省**: `plan_update` 与 `generation_propose` 同批调用导致 `terminate` 未生效，多一次总结请求 |
| #52 | **S7** `turn-s7-2` R1 | `user_message` | `media_overview`(nodeId=node-17) | 18,775 | 18,176 (96.8%) | 88 | 1,978 | 保留 |
| #53 | **S7** `turn-s7-2` R2 | `tool_result` | `media_inspect`(nodeId=node-17) | 19,115 | 18,432 (96.4%) | 344 | 3,229 | 保留 |
| #54 | **S7** `turn-s7-2` R3 | `media_attachment_followup` | `canvas_node_update`(nodeId=node-17, keys=[content]) | 19,782 | 18,816 (95.1%) | 723 | 6,060 | 保留 |
| #55 | **S7** `turn-s7-2` R4 | `tool_result` | `plan_update` + `canvas_generation_propose`(kind=image, nodeIds=[node-17]) | 20,758 | 19,456 (93.7%) | 375 | 3,138 | **可省**: 已知节点 ID 时改节点与 `generation_propose` 分两次往返（可同次发出） |
| #56 | **S7** `turn-s7-2` R5 | `tool_result` | `<final_reply>` | 21,567 | 20,480 (95.0%) | 142 | 2,629 | **可省**: `plan_update` 与 `generation_propose` 同批调用导致 `terminate` 未生效，多一次总结请求 |

---

## 5. 可省往返的 5 类根因拆解（阶段 2 优化靶点）

从上述 56 次真实请求中识别出的 **26 次可省往返（占总请求数 46.4%）** 集中在以下 5 类原因：

1. **`canvas_script_prepare` 报错回退与串行分步改画布（共 17 次请求，耗时 101,016 ms / 约 101.0 秒）**
   - **具体请求**：`S1 R3–R5`（3 次）、`S2 R3–R7`（5 次）、`S4 R3–R5`（3 次）、`S5 R3`（1 次）、`S6-1 R4`（1 次）、`S6-4 R3–R5`（3 次）、`S7-1 R3`（1 次）。
   - **原因**：
     - 模型在 `S1 R2`、`S2 R2`、`S4 R2`、`S6-4 R2` 严格按提示词调用复合操作 `canvas_script_prepare` 试图一次完成建脚本、写分镜行、建首帧/视频节点和连线，但评测模拟器 `sim-go.mjs` 未实现 `canvas.script.prepare`，抛出 `unsupported_operation`；模型被迫退回 `canvas_nodes_create` → `canvas_script_rows_append` → `canvas_node_configure` → `canvas_script_row_update` 多轮串行调用。
     - 单纯创建单图节点时（`S5`、`S7-1`），模型先调 `canvas_nodes_create`（只传 `title/prompt`），下一轮再调 `canvas_node_configure` 配 `model/size/count`。
   - **阶段 2 动作**：在 `sim-go.mjs` 补齐与 Go 后端一致的 `canvas.script.prepare` 实现；新宿主提示词与工具引导优先使用复合准备或同轮批量调用。

2. **单独调用 `plan_update` 占用整轮模型请求（共 4 次请求：`S2 R8`、`S4 R6`、`S6-1 R2`、`S6-1 R5`，耗时 13,489 ms / 约 13.5 秒）**
   - **原因**：这 4 笔请求均发生在 `tool_result` 之后——现有系统提示词要求多步创作维护 `plan_update` 且在提案或结束回复前先把计划步骤更新为完成（否则宿主 `planContinuation` 还会注入 `计划还没做完。继续做「...」` 自动续跑），导致模型在业务工具执行完毕后专门多花一整轮请求只调 `plan_update`。
   - **阶段 2 动作**：新宿主去掉 `planContinuation` 强制续跑循环，不再要求为收尾计划单独多跑一轮请求。

3. **`plan_update` 与 `canvas_generation_propose` 同批调用导致 `control.terminate` 失效（共 3 次请求：`S1 R7`、`S7-1 R5`、`S7-2 R5`，耗时约 8.9 秒）**
   - **原因**：`canvas_generation_propose` 成功时返回 `control: { terminate: true }` 以省去提案后的废话总结请求（如 `S4 R7`、`S5 R4`、`S6-4 R6` 均在提案后直接结束回合）；但当模型把 `plan_update` 与 `canvas_generation_propose` 在同一次响应中并发发出时，`plan_update` 未返回 `terminate`，导致 `pi-durable` 继续发起下一轮 `<final_reply>` 请求。
   - **阶段 2 动作**：新宿主在提案成功时无论同批是否带有 `plan_update`，均正常结束回合，不再多发总结请求。

4. **空画布已有 `<beeftv_studio>` 现场摘要仍调用 `canvas_get`（单列 1 次请求 `S6-1 R1` 耗时 9.7 秒，另在 `S1/S2/S4/S5/S7-1 R1` 与 `model_catalog` 同批发出）**
   - **原因**：请求末尾 `<beeftv_studio>` 已明确包含 `[制作现场｜画布版本 1｜本轮请求前的实际状态] 概况：画布是空的。`，但模型仍习惯性在首轮调用 `canvas_get`。
   - **阶段 2 动作**：新宿主精简系统提示词，明确 `<beeftv_studio>` 已是当前画布权威摘要，画布为空或无需读取截断长文时不必调用 `canvas_get`。

5. **已知节点 ID 时修改节点与 `canvas_generation_propose` 分两次往返（1 次请求：`S7-2 R4`，耗时 3.1 秒）**
   - **原因**：`S7` 第 2 轮复查已有节点 `node-17` 后，`R3` 调用 `canvas_node_update` 修改提示词，`R4` 再调用 `canvas_generation_propose`，原本可在 `R3` 同一响应内顺次发出。
   - **阶段 2 动作**：新宿主提示词明确已知 `nodeId` 时修改节点与 `canvas_generation_propose` 可在同一响应内发出。

---

## 6. 确定性假模型（`--model fake`）基线对照

运行 `bun eval/run-eval.mjs --model fake`（零外部费用，用于 CI 与本地快速对比）：

- **总句数 / 总请求数**：`11` 句 / **`47` 次请求**（平均 `4.27` 次/句）
- **可省请求数**：**`24` 次**（目标 **≤ `23` 次**）
- **分场景请求数（可省）**：
  - `S1`：1 句 / 5 次（可省 3）
  - `S2`：1 句 / 5 次（可省 3）
  - `S3`：1 句 / 3 次（可省 0）
  - `S4`：1 句 / 4 次（可省 2）
  - `S5`：1 句 / 4 次（可省 2）
  - `S6`：4 句 / 17 次（可省 10）
  - `S7`：2 句 / 9 次（可省 4）
