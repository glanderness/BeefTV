# 最终候选的本地执行观察摘要

执行日期：2026-10-28（北京时间）。提交 `30cba74daa153a44ade9dac56403a8e0bc238969`，源码 fingerprint `7145758f40c31439a24486f4addac63f1f7455cc3b970f20e46f71bb815cdb70`。

本文从本任务实际执行结果整理，不是原始终端日志。中断后 `/tmp` 原始日志、截图及未提交记录已找不到；原因未确定，不能声称附件完整。以下通过结果是此前实际读到的退出状态与输出，不是本轮重新运行。用户要求源码未变不重复检查。另存的 GitHub CI 日志是可以独立读回的原始记录。

## 命令及结果

| 执行目录 | 命令 | 实际观察 |
| --- | --- | --- |
| 根目录 | `bash scripts/verify-beeftv-local-release.sh` | 通过；原 5 秒冷启动标准、路由/SQLite、5 项前端测试/57 断言、tsc 与 Vite 构建完成。原 9.51 秒超时的原因仍未知 |
| `web/` | 下方 16 文件专项 | 177 pass、0 fail、3290 断言，161.91 秒 |
| `agent-host/` | `bun test durable-stream-events.test.mjs model-stream-idle.test.mjs` | 21 pass、0 fail、111 断言，7.47 秒 |
| 根目录 | `node --test scripts/v205-release-contract.test.mjs` | 31 项通过；这只验证合同，不能替代本版收据 |
| 根目录 | `python3 -m unittest discover -s scripts -p 'test_publish_desktop_r2.py'` | 44 项通过 |
| 根目录 | `python3 -m unittest discover -s scripts -p 'test_mirror_desktop_cnb.py'` | 4 项通过；输出中的 v2.0.4 是测试夹具，不是本版真实镜像 |
| `backend/` | `go test ./internal/plugins ./internal/protocol ./internal/repository ./internal/workspace -count=1` | 四包通过，分别 131.674 / 1.050 / 5.653 / 2.829 秒 |
| `backend/` | `go test ./internal/app -run '^TestVideoProtocol(Upgrade\|Rollback)' -count=1 -v -timeout=12m` | 通过，383.721 秒；含 12 个升级例、4 个删除 ID 保护例及 2 个回退例，恢复请求不重新 POST |
| `backend/` | 下方图片恢复专项 | 13 个顶层测试通过，67.440 秒 |
| `backend/` | `go test ./internal/generation -run 'Test(Video\|RunVideo\|Luma\|ImageReplay\|ImageResponse\|ImageRecovery\|DoBinaryRecoverable\|BeefTVImageSubmission\|Seedream)' -count=1` | 通过，13.485 秒 |
| `backend/` | `BEEFTV_IMAGE_RECOVERY_PROBE=1 go test ./internal/app -run '^TestManualImageRecoveryProbe$' -count=1 -v -timeout=20m` | 通过，244.844 秒，含人工等待，不是恢复耗时基准；免费明暗绘制观察见发布报告 |

前端专项：

```sh
bun test \
  test/assistant-stream-progress.browser.test.ts \
  test/canvas-agent-assistant-stream.test.ts \
  test/canvas-agent-assistant-wiring.test.ts \
  test/canvas-image-recovery.browser.test.ts \
  test/canvas-media-performance.test.ts \
  test/canvas-render-visibility.test.tsx \
  test/canvas-viewport-controller.browser.test.ts \
  test/canvas-viewport-style.browser.test.ts \
  test/assistant-model-selection.test.ts \
  test/settings-model-picker.browser.test.ts \
  test/channel-settings-pane.test.tsx \
  test/service-credentials.test.ts \
  test/manual-channel-protocol.test.ts \
  test/seedream-image.test.ts \
  test/timeline-placement.test.ts \
  test/timeline-preview-playback.browser.test.ts
```

图片恢复专项：

```sh
go test ./internal/app \
  -run '^(TestHistoricalImageAutoRecoveryDownloadsAndBindsLegacyCanvas|TestAutomaticImageRecovery.*|TestAutomaticImageReplay.*|TestRetryAcceptedImageUsesOriginalReceiptWithoutCreate|TestImageReceiptRecoveryRejectsAmbiguousAndFailedCreates)$' \
  -count=1 -v -timeout=120s
```

## 未执行及限制

完整十二条付费矩阵和整套助手验收没有执行，本次新增付费请求及支出均为零。历史影音、成片检查失败及未知账务保留。图片恢复使用本机假上游，不能宣称真实模型在线验证。最终四平台安装包、安装升级、签名与公开更新源另由正式发布流程验证。
