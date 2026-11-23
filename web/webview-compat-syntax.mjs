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
    "type",
    "loc",
    "start",
    "end",
    "extra",
    "tokens",
    "comments",
    "leadingComments",
    "trailingComments",
    "innerComments",
]);

/**
 * Returns true if a RegExp pattern contains an unescaped lookbehind assertion
 * (`(?<=` or `(?<!`) outside a character class `[...]`.
 * Safari 15.4-16.3 (macOS 12.3-13.2 WKWebView) throws a SyntaxError on RegExp
 * lookbehind literals at parse time and on RegExp constructor calls at runtime.
 *
 * @param {unknown} pattern
 * @returns {boolean}
 */
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

/**
 * Extracts a static string value from a Babel StringLiteral or expression-free TemplateLiteral.
 *
 * @param {unknown} node
 * @returns {string | null}
 */
function staticStringLiteral(node) {
    if (!node || typeof node !== "object") return null;
    const record = /** @type {Record<string, unknown>} */ (node);
    if (record.type === "StringLiteral" && typeof record.value === "string") {
        return record.value;
    }
    if (record.type === "TemplateLiteral" && Array.isArray(record.expressions) && record.expressions.length === 0 && Array.isArray(record.quasis)) {
        return record.quasis
            .map((quasi) => {
                const value = /** @type {{ value?: { cooked?: string | null; raw?: string } }} */ (quasi)?.value;
                return value?.cooked ?? value?.raw ?? "";
            })
            .join("");
    }
    return null;
}

/**
 * Best-effort check for whether a catch body directly throws (without crossing nested functions).
 *
 * @param {unknown} node
 * @returns {boolean}
 */
function containsDirectThrow(node) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(containsDirectThrow);
    const record = /** @type {Record<string, unknown>} */ (node);
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "ThrowStatement") return true;
    if (FUNCTION_BOUNDARY_NODES.has(type)) return false;
    for (const key in record) {
        if (SKIP_AST_KEYS.has(key)) continue;
        if (containsDirectThrow(record[key])) return true;
    }
    return false;
}

/**
 * @typedef {{ file: string; kind: string; line: number; column: number; detail: string }} WebViewSyntaxViolation
 */

/**
 * AST-scans emitted JS for syntax unsupported or unsafe in macOS 12.3-13.2 WKWebView
 * (Safari 15.4-16.3):
 * - RegExp lookbehind literals (parse-time SyntaxError) and unguarded RegExp(...) constructors
 *   (runtime SyntaxError; feature-detection calls directly inside `try { ... } catch {}` where
 *   the catch block does not rethrow are permitted, while deferred functions and instance fields
 *   reset the try-block context)
 * - RegExp `/v` unicodeSets flag on literals or unguarded RegExp(...) constructors (Safari 17+)
 * - ES2022 class static initialization blocks (Safari 16.4+)
 * - Top-level await (conservatively blocked due to partial/module-graph quirks in older WebKit)
 * - Import attributes (`with { type: ... }`, Safari 17.2+)
 *
 * @param {string} code
 * @param {string} [fileLabel]
 * @returns {WebViewSyntaxViolation[]}
 */
export function findUnsupportedWebViewSyntax(code, fileLabel = "<chunk>") {
    /** @type {WebViewSyntaxViolation[]} */
    const violations = [];
    let ast;
    try {
        ast = parse(code, {
            sourceType: "unambiguous",
            allowReturnOutsideFunction: true,
        });
    } catch (error) {
        const err = /** @type {{ loc?: { line?: number; column?: number }; message?: string }} */ (error);
        violations.push({
            file: fileLabel,
            kind: "ParseError",
            line: err?.loc?.line ?? 0,
            column: err?.loc?.column ?? 0,
            detail: String(err?.message || error),
        });
        return violations;
    }

    /**
     * @param {unknown} node
     * @param {boolean} inFunction
     * @param {boolean} inTryBlock
     */
    function walk(node, inFunction, inTryBlock) {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, inFunction, inTryBlock);
            return;
        }
        const record = /** @type {Record<string, unknown>} */ (node);
        const type = typeof record.type === "string" ? record.type : "";
        const loc = /** @type {{ start?: { line?: number; column?: number } } | undefined} */ (record.loc);
        const line = loc?.start?.line ?? 0;
        const column = loc?.start?.column ?? 0;

        if (type === "RegExpLiteral") {
            const pattern = typeof record.pattern === "string" ? record.pattern : "";
            const flags = typeof record.flags === "string" ? record.flags : "";
            if (hasRegExpLookbehind(pattern)) {
                violations.push({
                    file: fileLabel,
                    kind: "RegExpLookbehind",
                    line,
                    column,
                    detail: `/${pattern.slice(0, 80)}/${flags}`,
                });
            }
            if (flags.includes("v")) {
                violations.push({
                    file: fileLabel,
                    kind: "RegExpUnicodeSetsFlag",
                    line,
                    column,
                    detail: `/${pattern.slice(0, 80)}/${flags}`,
                });
            }
        } else if (
            !inTryBlock &&
            (type === "NewExpression" || type === "CallExpression") &&
            record.callee &&
            typeof record.callee === "object" &&
            /** @type {{ type?: string; name?: string }} */ (record.callee).type === "Identifier" &&
            /** @type {{ type?: string; name?: string }} */ (record.callee).name === "RegExp" &&
            Array.isArray(record.arguments)
        ) {
            const pattern = staticStringLiteral(record.arguments[0]);
            const flags = staticStringLiteral(record.arguments[1]);
            if (pattern !== null && hasRegExpLookbehind(pattern)) {
                violations.push({
                    file: fileLabel,
                    kind: "RegExpLookbehind",
                    line,
                    column,
                    detail: `RegExp(${JSON.stringify(pattern.slice(0, 80))})`,
                });
            }
            if (flags !== null && flags.includes("v")) {
                violations.push({
                    file: fileLabel,
                    kind: "RegExpUnicodeSetsFlag",
                    line,
                    column,
                    detail: `RegExp(..., ${JSON.stringify(flags)})`,
                });
            }
        } else if (type === "StaticBlock") {
            violations.push({
                file: fileLabel,
                kind: "ClassStaticBlock",
                line,
                column,
                detail: "ES2022 class static initialization block (requires Safari 16.4+)",
            });
        } else if (!inFunction && (type === "AwaitExpression" || (type === "ForOfStatement" && record.await === true))) {
            violations.push({
                file: fileLabel,
                kind: "TopLevelAwait",
                line,
                column,
                detail: "top-level await",
            });
        } else if (type === "ImportAttribute") {
            violations.push({
                file: fileLabel,
                kind: "ImportAttribute",
                line,
                column,
                detail: "import attribute (requires Safari 17.2+)",
            });
        }

        if (type === "TryStatement") {
            const handler = /** @type {{ body?: unknown } | null | undefined} */ (record.handler);
            const catchSwallowsError = Boolean(handler) && !containsDirectThrow(handler?.body);
            walk(record.block, inFunction, inTryBlock || catchSwallowsError);
            walk(record.handler, inFunction, inTryBlock);
            walk(record.finalizer, inFunction, inTryBlock);
            return;
        }

        if (type === "ClassProperty" || type === "ClassPrivateProperty") {
            if (record.computed) walk(record.key, inFunction, inTryBlock);
            walk(record.value, inFunction, record.static === true ? inTryBlock : false);
            return;
        }

        if (type === "ObjectMethod" || type === "ClassMethod" || type === "ClassPrivateMethod") {
            if (record.computed) walk(record.key, inFunction, inTryBlock);
            for (const key in record) {
                if (SKIP_AST_KEYS.has(key) || key === "key") continue;
                const child = record[key];
                if (child && typeof child === "object") {
                    walk(child, true, false);
                }
            }
            return;
        }

        const isFunctionBoundary = FUNCTION_BOUNDARY_NODES.has(type);
        const nextInFunction = inFunction || isFunctionBoundary;
        const nextInTryBlock = isFunctionBoundary ? false : inTryBlock;
        for (const key in record) {
            if (SKIP_AST_KEYS.has(key)) continue;
            const child = record[key];
            if (child && typeof child === "object") {
                walk(child, nextInFunction, nextInTryBlock);
            }
        }
    }

    walk(ast.program, false, false);
    return violations;
}

/**
 * Recursively scans every emitted and copied JS file in a Vite output directory.
 *
 * @param {string} distDir
 * @returns {{ scannedFiles: number; violations: WebViewSyntaxViolation[] }}
 */
export function scanDistDirectoryForWebViewSyntax(distDir) {
    /** @type {string[]} */
    const jsFiles = [];
    /** @param {string} current */
    function collect(current) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const fullPath = join(current, entry.name);
            if (entry.isDirectory()) {
                collect(fullPath);
            } else if (entry.isFile() && /\.(?:m?js|cjs)$/i.test(entry.name)) {
                jsFiles.push(fullPath);
            }
        }
    }
    collect(distDir);
    jsFiles.sort();

    /** @type {WebViewSyntaxViolation[]} */
    const violations = [];
    for (const file of jsFiles) {
        const label = relative(distDir, file).split("\\").join("/");
        const found = findUnsupportedWebViewSyntax(readFileSync(file, "utf8"), label);
        if (found.length > 0) violations.push(...found);
    }
    return { scannedFiles: jsFiles.length, violations };
}
