// 收集后端会返回给界面的中文报错，供 __tv 在显示时翻译。后端源码不改。
// 只取报错构造调用里的字面量；格式化动词（%s、%d、%w…）换成 {0}{1}…，与前端模板词条同一套写法。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CJK } from "./babel-plugin.mjs";
import { webDir } from "./scan.mjs";

const backendDir = join(webDir, "../backend");
const ERROR_CALL = /(?:fmt\.Errorf|errors\.New|BadAuthRequest|NewAppError|WrapAppError|workflowBad|Conflict|Forbidden|NotFound|Unauthorized|errInvalid|denied|fail\w*|InvalidModelSelection)\((?:[^()"]*,\s*)?"((?:[^"\\\n]|\\.)*)"|"msg":\s*"((?:[^"\\\n]|\\.)*)"/g;
const VERB = /%(?:%|[-+# 0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[vTtbcdoOqxXUeEfFgGsspw])/g;

function listGoFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listGoFiles(full));
        else if (name.endsWith(".go") && !name.endsWith("_test.go")) out.push(full);
    }
    return out;
}

const unescapeGo = (raw) => raw.replace(/\\(["\\])/g, "$1");

function toKey(raw) {
    let index = 0;
    return unescapeGo(raw).replace(VERB, (verb) => (verb === "%%" ? "%" : `{${index++}}`));
}

export function scanBackend() {
    const keys = new Set();
    for (const root of ["internal", "cmd"]) {
        for (const file of listGoFiles(join(backendDir, root))) {
            const code = readFileSync(file, "utf8");
            if (!CJK.test(code)) continue;
            for (const match of code.matchAll(ERROR_CALL)) {
                const raw = match[1] ?? match[2];
                if (!CJK.test(raw) || raw.includes("\\n") || raw.length > 200) continue;
                keys.add(toKey(raw));
            }
        }
    }
    return keys;
}
