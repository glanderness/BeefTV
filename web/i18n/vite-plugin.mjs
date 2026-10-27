import { transformAsync } from "@babel/core";
import i18nBabelPlugin, { CJK } from "./babel-plugin.mjs";
import { IGNORE_KEYS, allowObjectProps, isExcluded } from "./config.mjs";
import { parserPlugins, relOf, scan } from "./scan.mjs";

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
            if (!rel.startsWith("src/") || isExcluded(rel) || !CJK.test(code)) return null;
            const result = await transformAsync(code, {
                filename: file, babelrc: false, configFile: false, sourceMaps: true,
                parserOpts: { plugins: parserPlugins(file) },
                generatorOpts: { retainLines: true },
                plugins: [[i18nBabelPlugin, { mode: "transform", objectProps: allowObjectProps(rel), unsafe, ignore: IGNORE_KEYS }]],
            });
            return result?.code ? { code: result.code, map: result.map } : null;
        },
    };
}
