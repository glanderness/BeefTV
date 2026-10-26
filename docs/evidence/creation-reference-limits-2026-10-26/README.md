# 创作页参考素材上限（飞书需求 #41）截图证据

用仓库里真实的 `CreationComposer`、`CreationModeTabs` 和真实的模型能力配置（Seedance 2.0）在本机渲染后截取。没有连接后端、没有跑真实生成，也没有点任何会产生费用的按钮。

## 文件

- `01-reference-counts-by-type.png`：9 张图 + 2 个视频 + 2 段音频时，参考内容标签显示「全部 (13) 图片 (9/9) 视频 (2/3) 音频 (2/3)」。13 个素材可以同时选中，说明「合计 9 个」的总数上限已经不在了。
- `02-overflow-inline-notice.png`：从素材库再多选 3 张图，超出的部分不会加入，参考内容面板里就地提示「参考图最多 9 张，超出的 3 个素材没有加入」，图片计数仍是 9/9。
- `03-all-types-full.png`：三类都放满（9 图 + 3 视频 + 3 音频，合计 15 个），添加按钮变为不可用，提示「已达到当前模型的参考内容上限（参考图 9 张、参考视频 3 个、参考音频 3 段）」。
- `03-diagnostic-toast-hidden-by-global-css.png`：诊断用。`web/src/styles/globals.css` 有一条 `.ant-message, .ant-notification { display: none !important }`，全站关闭了右上角 Toast。

## 为什么超限提示改成面板内

因为上面那条全局规则，原来用 `toast.warning` 报「参考图最多 9 张」的提示在真实界面里根本看不到。所以超限说明改成参考内容面板内的 `creation-reference-notice`，页面里始终可见。原先那张「超限 Toast」截图（`02-reference-limit-reached.png`）拍的正是这个看不见的提示，已删除以免误导。