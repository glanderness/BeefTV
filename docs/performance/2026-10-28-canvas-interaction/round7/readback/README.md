# round7/readback：第六轮两侧实际插桩原件的只读读回

这些文件**不是**固定提交里的文件，而是 #101 独立复核在本轮从当时仍存在的工作区
（`/Volumes/Workspaces/Worktrees/BeefTV/canvas-interaction-perf-20261028/{before,after}`）只读读回的两侧
实际插桩源码。本目录是它们在第七轮里的副本，与复核分支 `tds/conv-01a18157-7169-7827-95ae-396dfaa56f49`
的 `docs/reviews/2026-10-28-canvas-connection-index/6654c90a/readback/` **逐字节一致**（13 份，已核对）。

用途：让 `round6-instrumentation-{before,after}.patch` 的来源可以在本分支内直接验证——
把补丁套到固定产品提交（before `6a155448`、after `e54d4863`）后，结果应与本目录对应文件逐字节相同。
`../static-check.py` 会做这个比对。

与「固定提交原件」的区别：

- **固定提交原件**：作者提交 `6654c90a` 里的文件（报告、探针、夹具、逐帧导出等），在本仓库
  `docs/performance/2026-10-28-canvas-interaction/` 下，由第七轮原样带入。
- **后来读回**（本目录）：复核在本轮读取的工作区源文件，不是提交内容，也不是历史运行时证明；
  它只证明「当时工作区里那份插桩长什么样」。
