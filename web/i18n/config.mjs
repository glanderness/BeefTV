// 阶段：1 = JSX 文本 / 白名单属性 / message 调用；2 = 再加对象上的 label/title 等属性
export const STAGE = Number(process.env.BEEFTV_I18N_STAGE || 1);

// 任何阶段都不处理的文件
const EXCLUDE_ALL = [/^src\/i18n\//, /\.test\.(t|j)sx?$/, /fixture/i];

// 阶段 2 的对象属性改写不处理的文件：提示词、模型 payload、协议层
const EXCLUDE_OBJECT_PROPS = [
    /^src\/services\//,
    /^src\/components\/canvas\/canvas-node-generation\.ts$/,
    /^src\/lib\/canvas\/canvas-emotion\.ts$/,
    /^src\/lib\/canvas\/canvas-image-source\.ts$/,
    /^src\/lib\/canvas\/.*prompt.*\.ts$/,
];

// 发现某条翻译会破坏行为时，把中文原文加到这里（不要改上游源码）
export const IGNORE_KEYS = new Set([]);

export const isExcluded = (rel) => EXCLUDE_ALL.some((re) => re.test(rel));
export const allowObjectProps = (rel) => STAGE >= 2 && !EXCLUDE_OBJECT_PROPS.some((re) => re.test(rel));
