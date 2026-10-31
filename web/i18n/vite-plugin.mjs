import { transformAsync } from "@babel/core";
import i18nBabelPlugin, { CJK } from "./babel-plugin.mjs";
import { IGNORE_KEYS, allowObjectProps, displayTranslate, isExcluded } from "./config.mjs";
import { parserPlugins, relOf, scan } from "./scan.mjs";

const DISPLAY_CALLEE = /\b(message|messageApi|notification|notificationApi|modal|modalApi|toast)\./;

export function beeftvI18n() {
    let unsafe = new Set();
    return {
        name: "beeftv-i18n",
        enforce: "pre",
        buildStart() {
            unsafe = scan().unsafe;
        },
        async transform(code, id) {
            const file = id.split("?")[0];
            if (!/\.(t|j)sx?$/.test(file) || file.includes("node_modules")) return null;
            const rel = relOf(file);
            if (!rel.startsWith("src/") || isExcluded(rel)) return null;
            // 阶段 4 里没有中文的组件也可能显示词典里的值（常量、后端报错），同样需要改写
            const display = displayTranslate() && (/\.(t|j)sx$/.test(file) || DISPLAY_CALLEE.test(code));
            if (!display && !CJK.test(code)) return null;
            const result = await transformAsync(code, {
                filename: file, babelrc: false, configFile: false, sourceMaps: true,
                parserOpts: { plugins: parserPlugins(file) },
                generatorOpts: { retainLines: true },
                plugins: [[i18nBabelPlugin, { mode: "transform", objectProps: allowObjectProps(rel), unsafe, ignore: IGNORE_KEYS, display }]],
            });
            return result?.code ? { code: result.code, map: result.map } : null;
        },
    };
}
