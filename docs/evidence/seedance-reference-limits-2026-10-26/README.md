# Seedance 参考素材下限的提示证据（2026-10-26）

用仓库里真实的 `CreationComposer`（创作输入框）、真实的 `assertVideoCapability` 和真实的模型能力配置（`seedance-2.0`，参考音频 2–15 秒、输出时长 4–15 秒）在本机渲染后截取。没有连接后端，没有跑真实生成，也没有点任何会产生费用的按钮。

## 文件

- `01-blocked-notice-in-composer.png`：三条被拦下时的提示都显示在输入框里、发送按钮上方，橙黄色、始终可见。文案由真实的提交核对函数 `videoSubmitNotice` 生成：
  - 输出时长低于下限：「输出时长为 3 秒，当前模型只支持 4–15 秒；请改成 4–15 秒后再提交」
  - 参考音频太短：「音频「配音.wav」时长为 1.90 秒，需要改到 2–15 秒；请换一段更长的音频后再提交」
  - 参考音频太长：「音频「旁白.wav」时长为 16.00 秒，需要改到 2–15 秒；请裁剪或换一段更短的音频后再提交」

几处都写清了哪一项、现在多少秒、要改成多少秒，以及下一步该做什么；过短和过长给的是相反且正确方向的建议。

## 为什么不放在右上角 Toast

`web/src/styles/globals.css` 里有一条全局规则 `.ant-message, .ant-notification { display: none !important; }`，全站的右上角 Toast 都是隐藏的。所以被拦下的说明改成输入框内的 `creation-composer-notice`（`role="alert"`），在提交按钮之前渲染，和 PR #258 参考素材面板内的提示是同一个思路：不加新按钮，不加设置项。

## 只在视频模式拦

提交前的这套核对只对视频生效。文本模式残留的 30 秒、图片模型的 10 张参考图都不会被视频合同误拦（Seedream 允许 14 张）。素材库里只有 `resource:` 标识、浏览器还没读到时长的音频，交给后端补查真实时长（`deferResourceMetadataToBackend`），不提前判成「时长无法读取」。

## 覆盖

- `web/test/creation-submit-guard.test.ts`：断言文本/图片模式不被视频合同拦、视频模式时长超范围给提示、`resource:` 素材交给后端补查、过短说过长/过长说裁短。
- `web/test/creation-composer-notice.test.tsx`：断言提示渲染在输入框内、带 `role="alert"`、位置在发送按钮之前；没有提示时不渲染这段。
- `web/test/video-reference-duration.test.ts`：断言提示文案包含素材名、当前秒数和目标范围，并能在对话记录里重新解释。
- `backend/internal/app/model_capability_test.go`：`TestSeedanceReferenceAudioMessageNamesItemAndFix`、`TestSeedanceDocumentedOutputDurationFloor`，后端返回的同样是这份文案。