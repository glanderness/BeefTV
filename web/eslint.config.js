import babelParser from "@babel/eslint-parser";
import { hasRegExpLookbehind } from "./webview-compat-syntax.mjs";

// 这不是风格检查。锁住已退场的 AntD 用法和已知会导致旧 WebView 崩溃的 API。
// 用 Babel 解析 TS/TSX：typescript-eslint 8 在 TypeScript 7 上会直接拒绝启动。
const emptyMessage = "列表和面板空态用 @/components/ui/product/empty-state 的 EmptyState，不要再引入 antd Empty。";
const confirmMessage = "命令式确认必须走 App.useApp().modal.confirm，静态 Modal.confirm 拿不到主题和 App 上下文。";

const lookbehindMessage = "Safari 15.4–16.3（macOS 12.3–13.2 系统 WKWebView）解析正则后行断言（(?<= / (?<!）会直接报 SyntaxError；请改用捕获前缀或显式边界判断。";

function staticStringValue(node) {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral") {
        return node.quasis.map((q) => q.value.raw ?? q.value.cooked ?? "").join("");
    }
    if (node.type === "TaggedTemplateExpression") {
        return node.quasi.quasis.map((q) => q.value.raw ?? q.value.cooked ?? "").join("");
    }
    return null;
}

const webviewCompatPlugin = {
    rules: {
        "no-regexp-lookbehind": {
            meta: { type: "problem" },
            create(context) {
                return {
                    Literal(node) {
                        if (node.regex && hasRegExpLookbehind(node.regex.pattern)) {
                            context.report({ node, message: lookbehindMessage });
                        }
                    },
                    NewExpression(node) {
                        if (node.callee?.type === "Identifier" && node.callee.name === "RegExp" && hasRegExpLookbehind(staticStringValue(node.arguments[0]))) {
                            context.report({ node, message: lookbehindMessage });
                        }
                    },
                    CallExpression(node) {
                        if (node.callee?.type === "Identifier" && node.callee.name === "RegExp" && hasRegExpLookbehind(staticStringValue(node.arguments[0]))) {
                            context.report({ node, message: lookbehindMessage });
                        }
                    },
                };
            },
        },
    },
};

// 源码里还有 react-hooks/exhaustive-deps 的 disable 注释。本闸门不启用 hooks 规则，
// 只挂一个空规则，避免 ESLint 把未知规则名当成错误。
const commentCompatPlugin = {
    rules: {
        "exhaustive-deps": {
            meta: { type: "problem" },
            create() {
                return {};
            },
        },
    },
};

export default [
    {
        ignores: ["dist/**", "node_modules/**", "coverage/**"],
    },
    {
        files: ["src/**/*.{ts,tsx}"],
        plugins: {
            "webview-compat": webviewCompatPlugin,
        },
        rules: {
            "no-restricted-properties": ["error", {
                property: "toSorted",
                message: "桌面 WebView 可能不支持 toSorted；对 filter/map 等新数组使用 sort，原数组需先复制。",
            }],
            "webview-compat/no-regexp-lookbehind": "error",
        },
    },
    {
        files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx,mjs}"],
        plugins: {
            "react-hooks": commentCompatPlugin,
        },
        linterOptions: {
            reportUnusedDisableDirectives: "off",
        },
        languageOptions: {
            parser: babelParser,
            parserOptions: {
                requireConfigFile: false,
                sourceType: "module",
                babelOptions: {
                    babelrc: false,
                    configFile: false,
                    presets: [["@babel/preset-typescript", { allExtensions: true, isTSX: true, allowDeclareFields: true }]],
                },
            },
        },
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        { name: "antd", importNames: ["Empty"], message: emptyMessage },
                        { name: "antd/es/empty", message: emptyMessage },
                        { name: "antd/lib/empty", message: emptyMessage },
                    ],
                },
            ],
            "no-restricted-syntax": [
                "error",
                {
                    selector: "CallExpression[callee.object.name='Modal'][callee.property.name='confirm']",
                    message: confirmMessage,
                },
            ],
        },
    },
];
