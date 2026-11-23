import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { fromMarkdown } from "mdast-util-from-markdown";
import remend from "remend";

import {
    beginStartupDiagnosticsScope,
    getClientDiagnosticEvents,
    initializeClientDiagnostics,
    recordDiagnosticEvent,
} from "@/services/diagnostics/client-diagnostics";
import { startCheckedWorkspace } from "@/services/diagnostics/startup-preflight";
import {
    recordWorkspaceStartupFailure,
    resetDesktopBootSnapshot,
} from "@/services/workspace-startup-state";
import { findUnsupportedWebViewSyntax, hasRegExpLookbehind } from "../webview-compat-syntax.mjs";

function extractLinks(markdown: string): string[] {
    const tree = fromMarkdown(markdown, {
        mdastExtensions: [gfmAutolinkLiteralFromMarkdown()],
    });
    const links: string[] = [];
    const visit = (node: { type?: string; url?: string; children?: unknown[] }) => {
        if (node.type === "link" && typeof node.url === "string") links.push(node.url);
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                if (child && typeof child === "object") visit(child as { type?: string; url?: string; children?: unknown[] });
            }
        }
    };
    visit(tree as unknown as { type?: string; url?: string; children?: unknown[] });
    return links;
}

test("mdast-util-gfm-autolink-literal preserves email autolink boundaries", () => {
    expect(extractLinks("hello@example.com")).toEqual(["mailto:hello@example.com"]);
    expect(extractLinks("contact (user.name+1@sub.example.com) today")).toEqual(["mailto:user.name+1@sub.example.com"]);
    expect(extractLinks("send to $hello@example.com now")).toEqual(["mailto:hello@example.com"]);
    expect(extractLinks("「hello@example.com」")).toEqual(["mailto:hello@example.com"]);
    expect(extractLinks("send to 😀hello@example.com now")).toEqual([]);
    expect(extractLinks("path/hello@example.com")).toEqual([]);
    expect(extractLinks("中文foo@example.com")).toEqual([]);
    expect(extractLinks("中a.b@c.com")).toEqual(["mailto:b@c.com"]);
    expect(extractLinks("invalid@example.com-")).toEqual([]);
    expect(extractLinks("visit https://beeftv.app and www.example.com")).toEqual([
        "https://beeftv.app",
        "http://www.example.com",
    ]);
});

test("webview syntax gate rejects Safari 15.4-incompatible constructs and verifies bundled mdast and remend dependencies", async () => {
    expect(hasRegExpLookbehind("(?<=a)b")).toBe(true);
    expect(hasRegExpLookbehind("(?<!a)b")).toBe(true);
    expect(hasRegExpLookbehind("(?<named>a)")).toBe(false);
    expect(hasRegExpLookbehind("\\(\\?<=a\\)")).toBe(false);
    expect(hasRegExpLookbehind("[(?<=]")).toBe(false);

    expect(findUnsupportedWebViewSyntax("const r = /(?<=a)b/;", "lb.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("const r = new RegExp('(?<=a)b');", "ctor-lb.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("const r = RegExp(`(?<!a)b`, 'gu');", "call-lb.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("const r = /[a-z]/v;", "v.js").map((v) => v.kind)).toEqual(["RegExpUnicodeSetsFlag"]);
    expect(findUnsupportedWebViewSyntax("const r = new RegExp('[a-z]', 'v');", "ctor-v.js").map((v) => v.kind)).toEqual(["RegExpUnicodeSetsFlag"]);
    expect(findUnsupportedWebViewSyntax("class A { static { console.log(1); } }", "sb.js").map((v) => v.kind)).toEqual(["ClassStaticBlock"]);
    expect(findUnsupportedWebViewSyntax("await Promise.resolve(1);", "tla.js").map((v) => v.kind)).toEqual(["TopLevelAwait"]);
    expect(findUnsupportedWebViewSyntax('import d from "./x.json" with { type: "json" };', "ia.js").map((v) => v.kind)).toEqual(["ImportAttribute"]);
    expect(findUnsupportedWebViewSyntax("const ok = (() => { try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; } })();", "feature-detect.js")).toEqual([]);
    expect(findUnsupportedWebViewSyntax("try { new RegExp('(?<=a)b'); } finally {}", "try-finally.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("try { new RegExp('(?<=a)b'); } catch (e) { throw e; }", "try-rethrow.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("try { const fn = () => new RegExp('(?<=a)b'); } catch {}", "deferred-in-try.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("try { class A { x = new RegExp('(?<=a)b'); } } catch {}", "instance-field-in-try.js").map((v) => v.kind)).toEqual(["RegExpLookbehind"]);
    expect(findUnsupportedWebViewSyntax("try { class A { static x = new RegExp('(?<=a)b'); } } catch {}", "static-field-in-try.js")).toEqual([]);
    expect(findUnsupportedWebViewSyntax("try { class A { [new RegExp('(?<=a)b').source]() {} } } catch {}", "computed-method-in-try.js")).toEqual([]);
    expect(findUnsupportedWebViewSyntax("async function ok() { await Promise.resolve(/(?<id>a)/); }", "ok.js")).toEqual([]);

    for (const pkg of ["mdast-util-gfm-autolink-literal", "remend"]) {
        const entryPath = fileURLToPath(import.meta.resolve(pkg));
        const built = await Bun.build({
            entrypoints: [entryPath],
            target: "browser",
            format: "esm",
        });
        expect(built.success).toBe(true);
        expect(built.outputs.length).toBeGreaterThan(0);
        for (const output of built.outputs) {
            const code = await output.text();
            expect(findUnsupportedWebViewSyntax(code, output.path)).toEqual([]);
        }
    }

    // Verify patched remend singleTilde behavior matches original lookbehind semantics,
    // including astral Unicode surrogate pairs (UTF-16 code-unit length 2).
    expect(remend("20~25")).toBe("20\\~25");
    expect(remend("a~b~c")).toBe("a\\~b\\~c");
    expect(remend("中文~测试")).toBe("中文\\~测试");
    expect(remend("𝕏~a")).toBe("𝕏\\~a");
    expect(remend("a~𝕏")).toBe("a\\~𝕏");
    expect(remend("𝕏~𝕏")).toBe("𝕏\\~𝕏");
    expect(remend("`𝕏~a`")).toBe("`𝕏~a`");
    expect(remend("a~~b~~")).toBe("a~~b~~");
    expect(remend("a~~b")).toBe("a~~b~~");
    expect(remend("`20~25`")).toBe("`20~25`");
    expect(remend("~25")).toBe("~25");
});

test("startup failure keeps clean user message while recording sanitized error name, detail, and stack", () => {
    resetDesktopBootSnapshot();
    beginStartupDiagnosticsScope();
    initializeClientDiagnostics();

    const syntaxError = new SyntaxError(
        "Invalid regular expression: invalid group specifier name from \\\\fileserver\\private\\share.png and /opt/secret/cfg.yml and open /workspace/bootstrap: denied token=super-secret-value",
    );
    syntaxError.stack = [
        "SyntaxError: Invalid regular expression",
        "    at /Users/demo/app.js:1:1",
        "    at file:///Applications/BeefTV.app/Contents/Resources/static/chunk.js:1:2",
        "    at prefixfile:///Applications/Hidden.app/a.js:1:2",
        "    at /workspace/private-project/bundle.js:1:3",
        "    at \\\\fileserver\\private\\share.js:1:4",
        "    at https://internal.example/chunk.js?token=abc:1:5",
    ].join("\n");

    const failure = recordWorkspaceStartupFailure(syntaxError);

    expect(failure.reason).toBe("workspace_bootstrap_failed");
    expect(failure.message).toBe("项目或模型配置未能完成读取。原有配置不会被覆盖，请重新加载或导出诊断包排查。");
    expect(failure.errorName).toBe("SyntaxError");
    expect(failure.errorDetail).toContain("Invalid regular expression");

    recordDiagnosticEvent({
        level: "info",
        category: "request",
        code: "request_ok",
        route: "/workspace/bootstrap",
        message: "GET /workspace/bootstrap",
    });

    const events = getClientDiagnosticEvents();
    const recorded = [...events].reverse().find((event) => event.code === "workspace_bootstrap_failed");
    expect(recorded).toBeDefined();
    expect(recorded?.message).toContain("SyntaxError");
    expect(recorded?.message).toContain("Invalid regular expression");
    for (const leaked of ["super-secret-value", "fileserver", "cfg.yml", "/workspace/bootstrap"]) {
        expect(recorded?.message).not.toContain(leaked);
    }
    expect(recorded?.stack).toContain("SyntaxError");
    for (const leaked of ["/Users/demo", "BeefTV.app", "Hidden.app", "private-project", "fileserver", "internal.example"]) {
        expect(recorded?.stack).not.toContain(leaked);
    }

    const requestEvent = [...events].reverse().find((event) => event.code === "request_ok");
    expect(requestEvent?.message).toBe("GET /workspace/bootstrap");

    resetDesktopBootSnapshot();
});

test("preflight startup catch exports sanitized error evidence in clientEvents", async () => {
    type FakeElement = {
        tagName: string;
        className: string;
        type: string;
        textContent: string;
        disabled: boolean;
        style: { cssText: string; display: string };
        attributes: Record<string, string>;
        children: FakeElement[];
        onclick: (() => void) | null;
        readonly firstChild: FakeElement | null;
        setAttribute: (name: string, value: string) => void;
        appendChild: (child: FakeElement) => FakeElement;
        removeChild: (child: FakeElement) => FakeElement;
    };

    const makeElement = (tagName: string): FakeElement => {
        const el: FakeElement = {
            tagName,
            className: "",
            type: "",
            textContent: "",
            disabled: false,
            style: { cssText: "", display: "" },
            attributes: {},
            children: [],
            onclick: null,
            get firstChild() {
                return el.children[0] ?? null;
            },
            setAttribute(name, value) {
                el.attributes[name] = value;
            },
            appendChild(child) {
                el.children.push(child);
                return child;
            },
            removeChild(child) {
                const idx = el.children.indexOf(child);
                if (idx >= 0) el.children.splice(idx, 1);
                return child;
            },
        };
        return el;
    };

    const findButtons = (node: FakeElement): FakeElement[] => [
        ...(node.tagName === "button" ? [node] : []),
        ...node.children.flatMap(findButtons),
    ];

    const root = makeElement("div");
    const exportedPayloads: string[] = [];
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;

    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
            getElementById: (id: string) => (id === "root" ? root : null),
            createElement: makeElement,
        },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            go: {
                main: {
                    DesktopApp: {
                        ExportStartupDiagnostics: async (payload: string) => {
                            exportedPayloads.push(payload);
                            return "/tmp/diag.zip";
                        },
                    },
                },
            },
        },
    });

    try {
        const syntaxError = new SyntaxError("Invalid regular expression from /opt/secret/file token=leaked-token");
        syntaxError.stack =
            "SyntaxError: Invalid regular expression\n    at file:///Applications/BeefTV.app/Contents/Resources/static/a.js:1:2\n    at \\\\corp\\share\\secret.js:3:4";

        const ok = await startCheckedWorkspace(
            async () => {
                throw syntaxError;
            },
            { secureRandom: true, structuredClone: true, indexedDB: true },
        );
        expect(ok).toBe(false);

        const exportButton = findButtons(root).find((btn) => btn.textContent === "导出诊断包");
        expect(exportButton?.onclick).toBeDefined();
        exportButton!.onclick!();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(exportedPayloads).toHaveLength(1);
        const parsed = JSON.parse(exportedPayloads[0]!) as {
            description: string;
            clientEvents: Array<{ code?: string; reason?: string; message?: string; stack?: string }>;
        };
        expect(parsed.description).toBe("preflight:workspace");
        expect(parsed.clientEvents).toHaveLength(1);
        const event = parsed.clientEvents[0]!;
        expect(event.code).toBe("workspace_bootstrap_failed");
        expect(event.reason).toBe("workspace_preflight_failed");
        expect(event.message).toContain("SyntaxError");
        expect(event.message).toContain("Invalid regular expression");
        expect(event.message).not.toContain("leaked-token");
        expect(event.message).not.toContain("/opt/secret");
        expect(event.stack).toContain("SyntaxError");
        expect(event.stack).not.toContain("BeefTV.app");
        expect(event.stack).not.toContain("corp");
    } finally {
        Object.defineProperty(globalThis, "document", { configurable: true, value: prevDocument });
        Object.defineProperty(globalThis, "window", { configurable: true, value: prevWindow });
    }
});
