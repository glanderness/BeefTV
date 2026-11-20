import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

const manifestPath = resolve(import.meta.dir, "../package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.dependencies["@tiptap/core"];
const isTiptap = (name: string) => name.startsWith("@tiptap/");
const isProseMirror = (name: string) => name.startsWith("prosemirror-");

describe("Tiptap dependency alignment", () => {
    test("pins direct dependencies and matching Bun overrides", () => {
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        for (const [name, specifier] of Object.entries(manifest.dependencies)) {
            if (isTiptap(name)) expect(specifier).toBe(version);
        }
        const overrides = Object.fromEntries(Object.entries(manifest.overrides).filter(([name]) => isTiptap(name)));
        expect(manifest.pnpm).toBeUndefined();
        for (const specifier of Object.values(overrides)) expect(specifier).toBe(version);
    });

    test("resolves the entire installed Tiptap dependency graph to the core version", () => {
        const visited = new Set<string>();
        function check(parent: string, name: string) {
            const path = createRequire(parent).resolve(`${name}/package.json`);
            if (visited.has(path)) return;
            visited.add(path);
            const dependency = JSON.parse(readFileSync(path, "utf8"));
            expect(`${name}@${dependency.version}`).toBe(`${name}@${version}`);
            expect(manifest.overrides[name]).toBe(version);
            const children = { ...dependency.dependencies, ...dependency.peerDependencies, ...dependency.optionalDependencies };
            for (const child of Object.keys(children).filter(isTiptap)) check(path, child);
        }
        for (const name of Object.keys(manifest.dependencies).filter(isTiptap)) check(manifestPath, name);
        expect(visited.size).toBeGreaterThan(Object.keys(manifest.dependencies).filter(isTiptap).length);
    });

    test("deduplicates every installed ProseMirror package across the Tiptap graph", () => {
        const visited = new Set<string>();
        const pmResolved = new Map<string, Set<string>>();
        function walk(parent: string, name: string) {
            const pkgPath = createRequire(parent).resolve(`${name}/package.json`);
            const dependency = JSON.parse(readFileSync(pkgPath, "utf8"));
            if (isProseMirror(name)) {
                const versions = pmResolved.get(name) ?? new Set<string>();
                versions.add(`${dependency.version}:${pkgPath}`);
                pmResolved.set(name, versions);
            }
            if (visited.has(pkgPath)) return;
            visited.add(pkgPath);
            const children = { ...dependency.dependencies, ...dependency.peerDependencies, ...dependency.optionalDependencies };
            for (const child of Object.keys(children).filter((dep) => isTiptap(dep) || isProseMirror(dep))) {
                walk(pkgPath, child);
            }
        }
        for (const name of Object.keys(manifest.dependencies).filter(isTiptap)) walk(manifestPath, name);
        expect(pmResolved.size).toBeGreaterThan(0);
        for (const [name, entries] of pmResolved.entries()) {
            expect([...entries], `${name} resolved to multiple copies`).toHaveLength(1);
        }
    });

    test("executes list and blockquote commands without duplicate ProseMirror Fragment errors", () => {
        const makeEditor = () =>
            new Editor({
                element: null,
                extensions: [StarterKit],
                content: {
                    type: "doc",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
                },
            });

        for (const [command, expectedNodeType] of [
            ["toggleBulletList", "bulletList"],
            ["toggleOrderedList", "orderedList"],
            ["toggleBlockquote", "blockquote"],
        ] as const) {
            const editor = makeEditor();
            try {
                expect(editor.commands[command]()).toBe(true);
                expect(editor.getJSON().content?.[0]?.type).toBe(expectedNodeType);
            } finally {
                editor.destroy();
            }
        }
    });
});
