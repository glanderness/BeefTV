# BeefTV 中英双语改造方案（构建期翻译层，可持续同步上游）

> 给执行模型：本文件已给出全部文件路径和核心代码，**照抄并按步骤执行，不要自行探索仓库、不要重构、不要改动未列出的上游文件**。遇到本文没覆盖的情况，停下来记录问题，不要猜。

## 0. 原理和硬约束

- 上游源码中的中文**一个字都不改**。Vite 插件在构建时把"显示用"的中文字面量改写成 `__t("中文原文")`，运行时按 `en.json` 查表；查不到就原样返回中文。
- 中文原文就是 key。上游新增文案时页面不报错，只是先显示中文，跑一次提取脚本后补翻译即可。
- 切换语言 = 写 `localStorage` 后刷新页面（模块顶层常量只在加载时计算一次，不做热切换）。
- 所有新增内容只放在 `web/i18n/`（构建脚本）和 `web/src/i18n/`（运行时）。只允许改下面这几个上游文件，每处改动都控制在几行内：

| 上游文件 | 改动 |
| --- | --- |
| `web/vite.config.ts` | 加 1 个 import，在 `plugins` 里加 1 项 |
| `web/src/components/layout/app-providers.tsx` | antd locale 跟随语言 |
| `web/src/components/video-player.tsx` | 英文时不传中文播放器文案 |
| `web/src/pages/settings/index.tsx` | 插入 1 行 `<LanguageSwitch />` |
| `web/src/services/api/request.ts` | （阶段 3，可选）错误信息走翻译 |

- **绝不翻译**：发给模型的提示词，以及用于比较、匹配或持久化的字符串。插件会自动把参与比较的中文加入 unsafe 集合并跳过；剩下的漏网情况靠配置里的排除列表处理。
- Bun 单测不经过 Vite，不受影响，不需要改测试。
- 不新增 npm 依赖（`@babel/core` 已在 devDependencies 中）。

## 1. 新建文件

### 1.1 `web/i18n/config.mjs`

```js
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
```

### 1.2 `web/i18n/babel-plugin.mjs`

```js
export const CJK = /[一-鿿]/;

const JSX_ATTRS = new Set(["title", "placeholder", "label", "alt", "aria-label", "tooltip", "okText", "cancelText", "description", "extra", "emptyText", "detail", "helperText", "subTitle", "subtitle", "content"]);
const OBJECT_PROPS = new Set(["label", "title", "description", "placeholder", "tooltip", "okText", "cancelText", "emptyText", "hint", "detail", "helperText", "subtitle", "caption"]);
const MESSAGE_CALLEE = /^(message|messageApi|notification|notificationApi|modal|modalApi|toast)$/;
const MESSAGE_METHODS = new Set(["success", "error", "warning", "warn", "info", "loading", "open", "confirm"]);
const MESSAGE_OBJECT_PROPS = new Set(["content", "title", "description", "message", "okText", "cancelText"]);
const COMPARE_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "split", "replace", "replaceAll", "match", "matchAll", "search", "test", "has", "get"]);
const COMPARE_OPS = new Set(["===", "!==", "==", "!=", "in"]);

export const normalizeJsxText = (raw) => raw.replace(/\s*\n\s*/g, " ").trim();
export const templateKey = (quasis) => quasis.map((q, i) => (q.value.cooked ?? q.value.raw) + (i < quasis.length - 1 ? `{${i}}` : "")).join("");

/**
 * options:
 *  mode: "transform" | "collect"
 *  objectProps: boolean           是否处理阶段 2 的对象属性
 *  unsafe: Set<string>            transform 模式下跳过的 key
 *  ignore: Set<string>            配置里手动忽略的 key
 *  sink: { keys: Set, unsafe: Set } collect 模式输出；collectKeys=false 时只收集 unsafe
 *  collectKeys: boolean
 */
export default function i18nBabelPlugin({ types: t }, opts) {
    const { mode = "transform", objectProps = false, unsafe = new Set(), ignore = new Set(), sink, collectKeys = true } = opts;
    const transform = mode === "transform";

    const ok = (key) => CJK.test(key) && !ignore.has(key) && (!transform || !unsafe.has(key));
    const callT = (key, args) => t.callExpression(t.identifier("__t"), args && args.length ? [t.stringLiteral(key), t.arrayExpression(args)] : [t.stringLiteral(key)]);

    function use(state, key) {
        state.i18nUsed = true;
        if (sink && collectKeys) sink.keys.add(key);
    }

    // 把条件/逻辑表达式展开到真正的取值位置
    function valuePaths(path) {
        if (path.isConditionalExpression()) return [...valuePaths(path.get("consequent")), ...valuePaths(path.get("alternate"))];
        if (path.isLogicalExpression()) return [...valuePaths(path.get("left")), ...valuePaths(path.get("right"))];
        return [path];
    }

    function rewrite(path, state) {
        for (const p of valuePaths(path)) {
            if (p.isStringLiteral()) {
                const key = p.node.value;
                if (!ok(key)) continue;
                use(state, key);
                if (transform) p.replaceWith(callT(key));
            } else if (p.isTemplateLiteral()) {
                const key = templateKey(p.node.quasis);
                if (!ok(key)) continue;
                use(state, key);
                if (transform) p.replaceWith(callT(key, p.node.expressions));
            }
        }
    }

    function markUnsafe(node) {
        if (!sink) return;
        if (t.isStringLiteral(node) && CJK.test(node.value)) sink.unsafe.add(node.value);
        if (t.isTemplateLiteral(node)) sink.unsafe.add(templateKey(node.quasis));
        if (t.isArrayExpression(node)) node.elements.forEach(markUnsafe);
    }

    return {
        name: "beeftv-i18n",
        visitor: {
            Program: {
                exit(path, state) {
                    if (!transform || !state.i18nUsed || path.scope.hasBinding("__t")) return;
                    path.unshiftContainer("body", t.importDeclaration([t.importSpecifier(t.identifier("__t"), t.identifier("__t"))], t.stringLiteral("@/i18n/runtime")));
                },
            },
            // ---- unsafe 收集（collect 模式）----
            BinaryExpression(path) {
                if (COMPARE_OPS.has(path.node.operator)) { markUnsafe(path.node.left); markUnsafe(path.node.right); }
            },
            SwitchCase(path) { if (path.node.test) markUnsafe(path.node.test); },
            // ---- 改写 ----
            JSXText(path, state) {
                const raw = path.node.value;
                const key = normalizeJsxText(raw);
                if (!key || !ok(key)) return;
                use(state, key);
                if (!transform) return;
                const lead = /^\s/.test(raw) && !/^\s*\n/.test(raw) ? " " : "";
                const trail = /\s$/.test(raw) && !/\n\s*$/.test(raw) ? " " : "";
                let expr = callT(key);
                if (lead) expr = t.binaryExpression("+", t.stringLiteral(lead), expr);
                if (trail) expr = t.binaryExpression("+", expr, t.stringLiteral(trail));
                path.replaceWith(t.jsxExpressionContainer(expr));
            },
            JSXAttribute(path, state) {
                const name = path.node.name;
                if (!t.isJSXIdentifier(name) || !JSX_ATTRS.has(name.name)) return;
                const value = path.get("value");
                if (value.isStringLiteral()) {
                    const key = value.node.value;
                    if (!ok(key)) return;
                    use(state, key);
                    if (transform) value.replaceWith(t.jsxExpressionContainer(callT(key)));
                } else if (value.isJSXExpressionContainer()) {
                    rewrite(value.get("expression"), state);
                }
            },
            JSXExpressionContainer(path, state) {
                if (path.parentPath.isJSXElement() || path.parentPath.isJSXFragment()) rewrite(path.get("expression"), state);
            },
            CallExpression(path, state) {
                const callee = path.node.callee;
                if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return;
                const method = callee.property.name;
                if (COMPARE_METHODS.has(method)) {
                    markUnsafe(callee.object);
                    path.node.arguments.forEach(markUnsafe);
                    return;
                }
                if (!t.isIdentifier(callee.object) || !MESSAGE_CALLEE.test(callee.object.name) || !MESSAGE_METHODS.has(method)) return;
                const first = path.get("arguments.0");
                if (!first || !first.node) return;
                if (first.isObjectExpression()) {
                    for (const prop of first.get("properties")) {
                        if (prop.isObjectProperty() && !prop.node.computed && t.isIdentifier(prop.node.key) && MESSAGE_OBJECT_PROPS.has(prop.node.key.name)) rewrite(prop.get("value"), state);
                    }
                } else {
                    rewrite(first, state);
                }
            },
            ObjectProperty(path, state) {
                if (!objectProps || path.node.computed) return;
                const key = path.node.key;
                const name = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null;
                if (!name || !OBJECT_PROPS.has(name)) return;
                if (path.findParent((p) => p.isTSType() || p.isTSInterfaceBody())) return;
                rewrite(path.get("value"), state);
            },
        },
    };
}
```

### 1.3 `web/i18n/scan.mjs`（插件和 CLI 共用）

```js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import i18nBabelPlugin, { CJK } from "./babel-plugin.mjs";
import { IGNORE_KEYS, allowObjectProps, isExcluded } from "./config.mjs";

export const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const relOf = (file) => relative(webDir, file).replaceAll("\\", "/");
export const parserPlugins = (file) => (/\.(t|j)sx$/.test(file) ? ["typescript", "jsx"] : ["typescript"]);

export function listSourceFiles(dir = join(webDir, "src")) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
        else if (/\.(t|j)sx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
}

// 扫描全部源码：keys = 需要翻译的文案；unsafe = 参与比较/匹配的中文（含被排除文件里的）
export function scan() {
    const sink = { keys: new Set(), unsafe: new Set() };
    for (const file of listSourceFiles()) {
        const code = readFileSync(file, "utf8");
        if (!CJK.test(code)) continue;
        const rel = relOf(file);
        transformSync(code, {
            filename: file, babelrc: false, configFile: false, code: false, ast: false,
            parserOpts: { plugins: parserPlugins(file) },
            plugins: [[i18nBabelPlugin, { mode: "collect", objectProps: allowObjectProps(rel), ignore: IGNORE_KEYS, sink, collectKeys: !isExcluded(rel) }]],
        });
    }
    for (const key of sink.unsafe) sink.keys.delete(key);
    return sink;
}
```

### 1.4 `web/i18n/vite-plugin.mjs`

```js
import { transformAsync } from "@babel/core";
import i18nBabelPlugin, { CJK } from "./babel-plugin.mjs";
import { IGNORE_KEYS, allowObjectProps, isExcluded } from "./config.mjs";
import { parserPlugins, relOf, scan } from "./scan.mjs";

export function beeftvI18n() {
    let unsafe = new Set();
    return {
        name: "beeftv-i18n",
        enforce: "pre",
        buildStart() {
            unsafe = scan().unsafe;
        },
        async transform(code, id) {
            const file = id.split("?")[0];
            if (!/\.(t|j)sx?$/.test(file) || file.includes("node_modules")) return null;
            const rel = relOf(file);
            if (!rel.startsWith("src/") || isExcluded(rel) || !CJK.test(code)) return null;
            const result = await transformAsync(code, {
                filename: file, babelrc: false, configFile: false, sourceMaps: true,
                parserOpts: { plugins: parserPlugins(file) },
                generatorOpts: { retainLines: true },
                plugins: [[i18nBabelPlugin, { mode: "transform", objectProps: allowObjectProps(rel), unsafe, ignore: IGNORE_KEYS }]],
            });
            return result?.code ? { code: result.code, map: result.map } : null;
        },
    };
}
```

### 1.5 `web/i18n/cli.mjs`（省 token 的关键：翻译只处理小批 JSON，不读整本词典）

```js
// 用法（在 web/ 下）：
//   bun i18n/cli.mjs extract            扫描源码，同步 en.json（新 key 置 ""），输出统计和 report.json
//   bun i18n/cli.mjs missing 200        把最多 200 条未翻译写到 i18n/batch.json
//   bun i18n/cli.mjs merge              把 i18n/batch.json 里已填好的译文合并回 en.json
//   bun i18n/cli.mjs check              存在未翻译条目时以退出码 1 结束（CI 用）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan, webDir } from "./scan.mjs";

const dictPath = join(webDir, "src/i18n/locales/en.json");
const batchPath = join(webDir, "i18n/batch.json");
const reportPath = join(webDir, "i18n/report.json");
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b, "zh")));

const [cmd, arg] = process.argv.slice(2);
const dict = read(dictPath);

if (cmd === "extract") {
    const { keys, unsafe } = scan();
    const next = {};
    for (const key of keys) next[key] = dict[key] ?? "";
    const obsolete = Object.keys(dict).filter((k) => !keys.has(k));
    if (!process.argv.includes("--prune")) for (const k of obsolete) next[k] = dict[k];
    write(dictPath, sorted(next));
    const missing = Object.values(next).filter((v) => !v).length;
    write(reportPath, { total: keys.size, missing, obsolete: obsolete.length, unsafe: [...unsafe].sort() });
    console.log(`keys=${keys.size} missing=${missing} obsolete=${obsolete.length} unsafe=${unsafe.size}`);
} else if (cmd === "missing") {
    const limit = Number(arg || 200);
    const batch = Object.fromEntries(Object.keys(dict).filter((k) => !dict[k]).slice(0, limit).map((k) => [k, ""]));
    write(batchPath, batch);
    console.log(`wrote ${Object.keys(batch).length} keys to i18n/batch.json`);
} else if (cmd === "merge") {
    const batch = read(batchPath);
    let n = 0;
    for (const [k, v] of Object.entries(batch)) if (v && k in dict) { dict[k] = v; n++; }
    write(dictPath, sorted(dict));
    console.log(`merged ${n}`);
} else if (cmd === "check") {
    const missing = Object.values(dict).filter((v) => !v).length;
    console.log(`missing=${missing}`);
    process.exit(missing ? 1 : 0);
} else {
    console.log("usage: bun i18n/cli.mjs extract|missing [n]|merge|check");
}
```

### 1.6 `web/src/i18n/runtime.ts`

```ts
import en from "./locales/en.json";

export type Locale = "zh-CN" | "en-US";
export const LOCALE_STORAGE_KEY = "beeftv.locale";

function readLocale(): Locale {
    try {
        return localStorage.getItem(LOCALE_STORAGE_KEY) === "en-US" ? "en-US" : "zh-CN";
    } catch {
        return "zh-CN";
    }
}

export const currentLocale: Locale = typeof window === "undefined" ? "zh-CN" : readLocale();
const dict: Record<string, string> = currentLocale === "en-US" ? (en as Record<string, string>) : {};

if (typeof document !== "undefined") document.documentElement.lang = currentLocale;

/** 构建期插件注入的翻译函数；key 为中文原文，模板变量为 {0}{1}… */
export function __t(key: string, args?: unknown[]): string {
    const template = dict[key] || key;
    if (!args) return template;
    return template.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)]) : match));
}

export function setLocale(next: Locale) {
    try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
        return;
    }
    window.location.reload();
}
```

### 1.7 `web/src/i18n/locales/en.json`

初始内容为 `{}`，之后由 `bun i18n/cli.mjs extract` 生成。

### 1.8 `web/src/i18n/language-switch.tsx`

```tsx
import { Select } from "antd";
import { currentLocale, setLocale, type Locale } from "./runtime";

const OPTIONS = [
    { value: "zh-CN", label: "中文" },
    { value: "en-US", label: "English" },
];

export function LanguageSwitch() {
    return <Select<Locale> size="small" value={currentLocale} options={OPTIONS} onChange={setLocale} style={{ width: 112 }} aria-label="Language" />;
}
```

### 1.9 `web/i18n/glossary.md`（翻译时只读这个文件，不要读源码）

```
画布 Canvas | 节点 Node | 素材 / 素材库 Asset / Asset Library | 项目 Project | 工作区 Workspace
分镜 Storyboard | 短剧 Short Drama | 镜头 Shot | 角色 Character | 场景 Scene | 剧本 Script
生成 Generate | 重新生成 Regenerate | 任务 Task | 渠道 Channel | 模型 Model | 供应商 Provider
插件 Plugin | 技能 Skill | 助手 Assistant | 导演台 Director | 时间线 Timeline | 参考图 Reference Image
提示词 Prompt | 负向提示词 Negative Prompt | 首帧 / 尾帧 First Frame / Last Frame | 配音 Voiceover
设置 Settings | 存储 Storage | 诊断 Diagnostics | 保存 Save | 取消 Cancel | 删除 Delete | 确定 OK
```

翻译规则：
1. 必须原样保留 `{0}`、`{1}` 等占位符，以及首尾空格。
2. 按钮和菜单用 Title Case（如 Save Project），句子用 Sentence case；中文标点换成英文标点。
3. 品牌名、模型名、供应商名（如即梦、可灵、Seedance）保留原名或拼音，不要意译。
4. 力求简短，英文长度尽量不超过中文的 2.5 倍，避免撑破布局。
5. 看不懂的条目留空，不要乱译（留空时显示中文）。

## 2. 修改上游文件（只改这些）

**`web/vite.config.ts`**

```ts
import { beeftvI18n } from "./i18n/vite-plugin.mjs";
// ...
plugins: [beeftvI18n(), react(), pruneOptionalMediaPlugin(), licenseNoticesPlugin()],
```

**`web/src/components/layout/app-providers.tsx`**

```tsx
import enUS from "antd/locale/en_US";
import { currentLocale } from "@/i18n/runtime";
// ...
<ConfigProvider locale={currentLocale === "en-US" ? enUS : zhCN} ...>
```

**`web/src/components/video-player.tsx`**：找到 `translations={zhCNTranslations}`，改成 `translations={currentLocale === "en-US" ? undefined : zhCNTranslations}`，并补上 `import { currentLocale } from "@/i18n/runtime";`。vidstack 默认就是英文。

**`web/src/pages/settings/index.tsx`**：在 `<main className="settings-page ...">` 的第一个子元素之前插入一行：

```tsx
<div className="flex justify-end px-4 pt-3"><LanguageSwitch /></div>
```

并补上 `import { LanguageSwitch } from "@/i18n/language-switch";`。

## 3. 执行步骤与验收

每完成一个阶段提交一次，提交说明格式为 `feat(i18n): 双语 - <摘要>`。

### 阶段 1：基础设施 + JSX 文案

1. 按第 1、2 节创建和修改文件，`en.json` 先写 `{}`。
2. `cd web && bun i18n/cli.mjs extract`，记录输出的 `keys / missing / unsafe`。
3. `bun run build` 必须通过。
4. 自检产物：`grep -l "beeftv.locale" dist/static/*.js` 找到 runtime chunk 文件名（如 `runtime-xxxx.js`），再用 `grep -l "runtime-xxxx" dist/static/*.js | wc -l` 统计引用它的 chunk 数，应远大于 1。不要搜 `__t(`：压缩后函数名会被改掉。
5. 循环翻译，直到 missing 为 0 或只剩看不懂的条目：
   - `bun i18n/cli.mjs missing 200`
   - 只读 `i18n/glossary.md` 和 `i18n/batch.json`，把 batch.json 的值填成英文后写回
   - `bun i18n/cli.mjs merge`
6. 再跑一次 `bun run build`。浏览器验证由用户进行（本仓库约定不主动启动 dev server）：在控制台执行 `localStorage.setItem("beeftv.locale","en-US")` 后刷新，检查项目列表、画布、设置、素材库；再切回 `zh-CN`，确认界面与改造前一致。

### 阶段 2：对象属性（菜单项、选项等）

1. `BEEFTV_I18N_STAGE=2 bun i18n/cli.mjs extract`，按阶段 1 第 5 步补齐翻译。
2. 构建时同样带上 `BEEFTV_I18N_STAGE=2`。如果默认就要阶段 2，把 `config.mjs` 里的默认值改成 2。
3. 打开 `i18n/report.json` 的 `unsafe` 列表：这些中文因为参与了比较，所以不会被翻译，界面上会保持中文，这是预期行为。
4. 如果某处翻译导致功能异常（按钮点了没反应、筛选失效等），把对应中文原文加进 `config.mjs` 的 `IGNORE_KEYS`；整个文件都有问题时加进 `EXCLUDE_OBJECT_PROPS`。**不要改上游源码。**

### 阶段 3：已由阶段 4 取代，不再修改 `request.ts`

### 阶段 4：显示时翻译（当前默认）

源码仍然不改，只在"显示到屏幕前的最后一刻"再查一次词典：

- 插件把 JSX 子节点、白名单属性、`message.*` 等提示调用里的变量包成 `__tv(x)`；提示调用写成 `__tv(x, 1)`，整句查不到时按标点拆开逐段翻译。
- `__tv` 只翻译"是中文且词典里有"的字符串，其余原样返回；中文界面下直接返回。带 `{0}` 的词条会编成正则，用来认出已经拼好变量的整句。
- 这些位置只做显示，所以 JSX 里的字面量不再受 `unsafe` 限制；`unsafe` 词条也进词典，代码里的比较仍用中文原值。
- 词典来源：前端显示位置的文案 + "可能被显示"的字面量（`.tsx` 文件、`new XxxError(...)`、名字像 label/message/title 的函数/属性/变量）进 `en.json`；后端报错构造调用里的中文（`%s` 等换成 `{0}`）进 `en.backend.json`。后端 Go 代码不改。
- `bun i18n/cli.mjs merge` 会拒绝占位符和原文不一致的译文。
- 关闭阶段 4：`BEEFTV_I18N_STAGE=2`。

## 4. 已知限制（不要试图修）

- `<span>共 {n} 项</span>` 会拆成"共"和"项"两条分别翻译，必要时把两条的译文填得能拼成一句。
- 用户自己输入的内容（节点名、项目名）只有和词典条目完全相同时才会被翻译（如默认名"未命名项目"）。
- 模型返回的内容不翻译。

## 5. 同步上游的日常流程

```bash
git remote add upstream https://github.com/glanderness/BeefTV.git   # 只需一次
git fetch upstream
git merge upstream/main
cd web && bun i18n/cli.mjs extract    # 更新词典，查看 missing
# 有 missing（含 backendMissing）时按阶段 1 第 5 步补翻译
bun run build
```

合并冲突只会出现在第 0 节表格列出的文件里。处理方法：先采用上游版本，再按第 2 节重新加上对应的几行改动。

## 6. 停止条件

- 同一个错误连续失败 3 次：停下，记录现象和已排除的原因，交给用户。
- 构建报 Babel 解析错误：把出错文件加进 `config.mjs` 的 `EXCLUDE_ALL`，记录文件名后继续。
- 不要为了让翻译生效去改上游组件，不要引入 i18next 等库，不要改后端。
