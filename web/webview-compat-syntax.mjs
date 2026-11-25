import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

const FUNCTION_BOUNDARY_NODES = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "ObjectMethod",
    "ClassMethod",
    "ClassPrivateMethod",
]);

const SKIP_AST_KEYS = new Set([
    "type", "loc", "start", "end", "extra", "tokens", "comments",
    "leadingComments", "trailingComments", "innerComments",
]);

// Safari 15.4-16.3 (macOS 12.3-13.2 WKWebView) throws SyntaxError on unescaped
// lookbehind assertions (`(?<=` / `(?<!`) outside `[...]` character classes.
export function hasRegExpLookbehind(pattern) {
    if (typeof pattern !== "string" || !pattern.includes("(?<")) return false;
    let inCharClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (inCharClass) {
            if (ch === "]") inCharClass = false;
            continue;
        }
        if (ch === "[") {
            inCharClass = true;
            continue;
        }
        if (ch === "(" && pattern[i + 1] === "?" && pattern[i + 2] === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!")) {
            return true;
        }
    }
    return false;
}

function staticStringLiteral(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0 && Array.isArray(node.quasis)) {
        return node.quasis.map((q) => q?.value?.cooked ?? q?.value?.raw ?? "").join("");
    }
    return null;
}

function containsDirectThrow(node) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(containsDirectThrow);
    if (node.type === "ThrowStatement") return true;
    if (FUNCTION_BOUNDARY_NODES.has(node.type)) return false;
    for (const key in node) {
        if (!SKIP_AST_KEYS.has(key) && containsDirectThrow(node[key])) return true;
    }
    return false;
}

// AST-scans emitted JS for syntax unsupported in macOS 12.3-13.2 WKWebView (Safari 15.4-16.3):
// RegExp lookbehind & `/v` flag (literals and unguarded RegExp() calls), ES2022 class static
// blocks, top-level await, and import attributes.
export function findUnsupportedWebViewSyntax(code, fileLabel = "<chunk>") {
    const violations = [];
    const report = (node, kind, detail) => {
        violations.push({
            file: fileLabel,
            kind,
            line: node?.loc?.start?.line ?? 0,
            column: node?.loc?.start?.column ?? 0,
            detail,
        });
    };

    let ast;
    try {
        ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
    } catch (error) {
        violations.push({
            file: fileLabel,
            kind: "ParseError",
            line: error?.loc?.line ?? 0,
            column: error?.loc?.column ?? 0,
            detail: String(error?.message || error),
        });
        return violations;
    }

    function walkChildren(node, inFunction, inTryBlock, skipKey = "") {
        for (const key in node) {
            if (SKIP_AST_KEYS.has(key) || key === skipKey) continue;
            const child = node[key];
            if (child && typeof child === "object") walk(child, inFunction, inTryBlock);
        }
    }

    function walk(node, inFunction, inTryBlock) {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, inFunction, inTryBlock);
            return;
        }
        const { type } = node;

        if (type === "RegExpLiteral") {
            const pattern = typeof node.pattern === "string" ? node.pattern : "";
            const flags = typeof node.flags === "string" ? node.flags : "";
            if (hasRegExpLookbehind(pattern)) report(node, "RegExpLookbehind", `/${pattern.slice(0, 80)}/${flags}`);
            if (flags.includes("v")) report(node, "RegExpUnicodeSetsFlag", `/${pattern.slice(0, 80)}/${flags}`);
        } else if (
            !inTryBlock &&
            (type === "NewExpression" || type === "CallExpression") &&
            node.callee?.type === "Identifier" &&
            node.callee.name === "RegExp" &&
            Array.isArray(node.arguments)
        ) {
            const pattern = staticStringLiteral(node.arguments[0]);
            const flags = staticStringLiteral(node.arguments[1]);
            if (pattern !== null && hasRegExpLookbehind(pattern)) {
                report(node, "RegExpLookbehind", `RegExp(${JSON.stringify(pattern.slice(0, 80))})`);
            }
            if (flags !== null && flags.includes("v")) {
                report(node, "RegExpUnicodeSetsFlag", `RegExp(..., ${JSON.stringify(flags)})`);
            }
        } else if (type === "StaticBlock") {
            report(node, "ClassStaticBlock", "ES2022 class static initialization block (requires Safari 16.4+)");
        } else if (!inFunction && (type === "AwaitExpression" || (type === "ForOfStatement" && node.await === true))) {
            report(node, "TopLevelAwait", "top-level await");
        } else if (type === "ImportAttribute") {
            report(node, "ImportAttribute", "import attribute (requires Safari 17.2+)");
        }

        if (type === "TryStatement") {
            const catchSwallowsError = Boolean(node.handler) && !containsDirectThrow(node.handler?.body);
            walk(node.block, inFunction, inTryBlock || catchSwallowsError);
            walk(node.handler, inFunction, inTryBlock);
            walk(node.finalizer, inFunction, inTryBlock);
            return;
        }
        if (type === "ClassProperty" || type === "ClassPrivateProperty") {
            if (node.computed) walk(node.key, inFunction, inTryBlock);
            walk(node.value, inFunction, node.static === true ? inTryBlock : false);
            return;
        }
        if (type === "ObjectMethod" || type === "ClassMethod" || type === "ClassPrivateMethod") {
            if (node.computed) walk(node.key, inFunction, inTryBlock);
            walkChildren(node, true, false, "key");
            return;
        }

        const isFn = FUNCTION_BOUNDARY_NODES.has(type);
        walkChildren(node, inFunction || isFn, isFn ? false : inTryBlock);
    }

    walk(ast.program, false, false);
    return violations;
}

export function scanDistDirectoryForWebViewSyntax(distDir) {
    const jsFiles = [];
    for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && /\.(?:m?js|cjs)$/i.test(entry.name)) {
            jsFiles.push(join(entry.parentPath ?? entry.path, entry.name));
        }
    }
    jsFiles.sort();

    const violations = [];
    for (const file of jsFiles) {
        const label = relative(distDir, file).split("\\").join("/");
        violations.push(...findUnsupportedWebViewSyntax(readFileSync(file, "utf8"), label));
    }
    return { scannedFiles: jsFiles.length, violations };
}
