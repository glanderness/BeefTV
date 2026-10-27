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
