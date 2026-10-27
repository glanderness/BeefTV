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
