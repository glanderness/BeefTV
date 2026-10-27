export const CJK = /[一-鿿]/;

const JSX_ATTRS = new Set(["title", "placeholder", "label", "alt", "aria-label", "tooltip", "okText", "cancelText", "description", "extra", "emptyText", "detail", "helperText", "help", "subTitle", "subtitle", "content"]);
const OBJECT_PROPS = new Set(["label", "title", "description", "placeholder", "tooltip", "okText", "cancelText", "emptyText", "hint", "detail", "helperText", "subtitle", "caption"]);
const MESSAGE_CALLEE = /^(message|messageApi|notification|notificationApi|modal|modalApi|toast)$/;
const MESSAGE_METHODS = new Set(["success", "error", "warning", "warn", "info", "loading", "open", "confirm"]);
const MESSAGE_OBJECT_PROPS = new Set(["content", "title", "description", "message", "okText", "cancelText"]);
const COMPARE_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "split", "replace", "replaceAll", "match", "matchAll", "search", "test", "has", "get"]);
const COMPARE_OPS = new Set(["===", "!==", "==", "!=", "in"]);

// 阶段 4 收集"可能被显示"的字面量：源码不改写，只进词典，显示时由 __tv 查到
const DISPLAY_NAME = /(label|message|text|title|hint|help|desc|description|error|reason|summary|tip|status|caption|name|notice|warning)$/i;

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
 *  candidates: boolean            collect 模式下把可能被显示的字面量也收进词典（见 displayCandidate）
 *  display: boolean               阶段 4：JSX 和提示调用里的变量包一层 __tv，显示前再查词典；
 *                                 这些位置只做显示，所以字面量不再受 unsafe 限制
 */
export default function i18nBabelPlugin({ types: t }, opts) {
    const { mode = "transform", objectProps = false, unsafe = new Set(), ignore = new Set(), sink, collectKeys = true, display = false, candidates = false } = opts;
    const transform = mode === "transform";

    const ok = (key, displayOnly) => CJK.test(key) && !ignore.has(key) && (!transform || displayOnly || !unsafe.has(key));
    const callT = (key, args) => t.callExpression(t.identifier("__t"), args && args.length ? [t.stringLiteral(key), t.arrayExpression(args)] : [t.stringLiteral(key)]);
    const callTV = (expr, loose) => t.callExpression(t.identifier("__tv"), loose ? [expr, t.numericLiteral(1)] : [expr]);

    function use(state, key) {
        state.i18nUsed = true;
        if (sink && collectKeys) sink.keys.add(key);
    }

    // 只包可能取到字符串的表达式；JSX、函数、对象、数字等原样保留
    function wrappable(p) {
        if (p.isIdentifier()) return p.node.name !== "undefined";
        if (p.isCallExpression() || p.isOptionalCallExpression()) return !(t.isIdentifier(p.node.callee) && /^__tv?$/.test(p.node.callee.name));
        return p.isMemberExpression() || p.isOptionalMemberExpression() || p.isTSAsExpression() || p.isTSNonNullExpression();
    }

    // 把条件/逻辑表达式展开到真正的取值位置
    function valuePaths(path) {
        if (path.isConditionalExpression()) return [...valuePaths(path.get("consequent")), ...valuePaths(path.get("alternate"))];
        if (path.isLogicalExpression()) return [...valuePaths(path.get("left")), ...valuePaths(path.get("right"))];
        return [path];
    }

    // displayOnly：该位置的值只用于显示（JSX、提示调用）；loose：提示文案允许按分句翻译
    function rewrite(path, state, displayOnly = false, loose = false) {
        for (const p of valuePaths(path)) {
            if (p.isStringLiteral()) {
                const key = p.node.value;
                if (!ok(key, displayOnly && display)) continue;
                use(state, key);
                if (transform) p.replaceWith(callT(key));
            } else if (p.isTemplateLiteral()) {
                const key = templateKey(p.node.quasis);
                if (!ok(key, displayOnly && display)) continue;
                use(state, key);
                if (transform) p.replaceWith(callT(key, p.node.expressions));
            } else if (transform && display && displayOnly && wrappable(p)) {
                state.tvUsed = true;
                p.replaceWith(callTV(p.node, loose));
            }
        }
    }

    // 组件文件里的文案、Error 构造、名字像 label/message 的函数/属性/变量里的文案
    function displayCandidate(path, key, state) {
        if (!candidates || !sink || !collectKeys || !CJK.test(key) || key.length > 120 || key.includes("\n") || ignore.has(key)) return;
        if (path.parentPath.isImportDeclaration() || path.parentPath.isExportDeclaration() || path.findParent((p) => p.isTSType())) return;
        if (state.filename?.endsWith("x") || path.findParent((p) => p.isNewExpression() && /Error$/.test(p.node.callee.name || ""))) {
            sink.keys.add(key);
            return;
        }
        const fn = path.getFunctionParent();
        const prop = path.findParent((p) => p.isObjectProperty());
        const decl = path.findParent((p) => p.isVariableDeclarator());
        const names = [fn?.node.id?.name, fn?.parentPath.node.id?.name, fn?.parentPath.node.key?.name, prop?.node.key.name ?? prop?.node.key.value, decl?.node.id.name];
        if (names.some((name) => typeof name === "string" && DISPLAY_NAME.test(name))) sink.keys.add(key);
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
                    if (!transform) return;
                    const names = [state.i18nUsed && "__t", state.tvUsed && "__tv"].filter((name) => name && !path.scope.hasBinding(name));
                    if (!names.length) return;
                    path.unshiftContainer("body", t.importDeclaration(names.map((name) => t.importSpecifier(t.identifier(name), t.identifier(name))), t.stringLiteral("@/i18n/runtime")));
                },
            },
            // ---- 显示候选和 unsafe 收集（collect 模式）----
            StringLiteral(path, state) {
                if (!transform) displayCandidate(path, path.node.value, state);
            },
            TemplateLiteral(path, state) {
                if (!transform) displayCandidate(path, templateKey(path.node.quasis), state);
            },
            BinaryExpression(path) {
                if (COMPARE_OPS.has(path.node.operator)) { markUnsafe(path.node.left); markUnsafe(path.node.right); }
            },
            SwitchCase(path) { if (path.node.test) markUnsafe(path.node.test); },
            // ---- 改写 ----
            JSXText(path, state) {
                const raw = path.node.value;
                const key = normalizeJsxText(raw);
                if (!key || !ok(key, display)) return;
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
                    if (!ok(key, display)) return;
                    use(state, key);
                    if (transform) value.replaceWith(t.jsxExpressionContainer(callT(key)));
                } else if (value.isJSXExpressionContainer()) {
                    rewrite(value.get("expression"), state, true);
                }
            },
            JSXExpressionContainer(path, state) {
                if (path.parentPath.isJSXElement() || path.parentPath.isJSXFragment()) rewrite(path.get("expression"), state, true);
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
                        if (prop.isObjectProperty() && !prop.node.computed && t.isIdentifier(prop.node.key) && MESSAGE_OBJECT_PROPS.has(prop.node.key.name)) rewrite(prop.get("value"), state, true, true);
                    }
                } else {
                    rewrite(first, state, true, true);
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
