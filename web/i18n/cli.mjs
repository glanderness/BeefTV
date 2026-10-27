// 用法（在 web/ 下）：
//   bun i18n/cli.mjs extract            扫描前端和后端源码，同步 en.json / en.backend.json（新 key 置 ""），输出统计和 report.json
//   bun i18n/cli.mjs missing 200        把最多 200 条未翻译写到 i18n/batch.json（先前端后后端）
//   bun i18n/cli.mjs merge              把 i18n/batch.json 里已填好的译文合并回对应词典
//   bun i18n/cli.mjs check              前端词典存在未翻译条目时以退出码 1 结束（CI 用；后端报错词条不阻断）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanBackend } from "./backend-scan.mjs";
import { scan, webDir } from "./scan.mjs";

const dictPath = join(webDir, "src/i18n/locales/en.json");
const backendDictPath = join(webDir, "src/i18n/locales/en.backend.json");
const batchPath = join(webDir, "i18n/batch.json");
const reportPath = join(webDir, "i18n/report.json");
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b, "zh")));

const [cmd, arg] = process.argv.slice(2);
const dict = read(dictPath);
const backendDict = read(backendDictPath);

function sync(path, current, keys) {
    const next = {};
    for (const key of keys) next[key] = current[key] ?? "";
    const obsolete = Object.keys(current).filter((k) => !keys.has(k));
    if (!process.argv.includes("--prune")) for (const k of obsolete) next[k] = current[k];
    write(path, sorted(next));
    return { missing: Object.values(next).filter((v) => !v).length, obsolete: obsolete.length };
}

if (cmd === "extract") {
    const { keys, unsafe } = scan();
    const front = sync(dictPath, dict, keys);
    const backendKeys = scanBackend();
    for (const key of keys) backendKeys.delete(key);
    const back = sync(backendDictPath, backendDict, backendKeys);
    write(reportPath, { total: keys.size, missing: front.missing, obsolete: front.obsolete, backend: backendKeys.size, backendMissing: back.missing, unsafe: [...unsafe].sort() });
    console.log(`keys=${keys.size} missing=${front.missing} obsolete=${front.obsolete} unsafe=${unsafe.size} backend=${backendKeys.size} backendMissing=${back.missing}`);
} else if (cmd === "missing") {
    const limit = Number(arg || 200);
    const pending = [...Object.keys(dict).filter((k) => !dict[k]), ...Object.keys(backendDict).filter((k) => !backendDict[k])];
    const batch = Object.fromEntries(pending.slice(0, limit).map((k) => [k, ""]));
    write(batchPath, batch);
    console.log(`wrote ${Object.keys(batch).length} keys to i18n/batch.json`);
} else if (cmd === "merge") {
    const batch = read(batchPath);
    const slots = (text) => (text.match(/\{\d+\}/g) ?? []).sort().join();
    let n = 0;
    for (const [k, v] of Object.entries(batch)) {
        if (!v) continue;
        if (slots(k) !== slots(v)) {
            console.warn(`skip（占位符不一致）: ${k} => ${v}`);
            continue;
        }
        if (k in dict) dict[k] = v;
        else if (k in backendDict) backendDict[k] = v;
        else continue;
        n++;
    }
    write(dictPath, sorted(dict));
    write(backendDictPath, sorted(backendDict));
    console.log(`merged ${n}`);
} else if (cmd === "check") {
    const missing = Object.values(dict).filter((v) => !v).length;
    console.log(`missing=${missing}`);
    process.exit(missing ? 1 : 0);
} else {
    console.log("usage: bun i18n/cli.mjs extract|missing [n]|merge|check");
}
