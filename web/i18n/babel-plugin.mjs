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
