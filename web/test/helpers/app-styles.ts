import { readFileSync } from "node:fs";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// 组件浏览器测试共用：从源码编译工作台样式，不依赖构建产物（CI 的网页检查不跑 build）。
// extraCss 是测试入口自己打包出来的样式，拼在最后。
export async function compileAppStyles(extraCss: string[] = []) {
    const webRoot = import.meta.dir + "/../..";
    const globalsPath = webRoot + "/src/styles/globals.css";
    const compiled = (await postcss([tailwind({ base: webRoot })]).process(readFileSync(globalsPath, "utf8"), { from: globalsPath })).css;
    return [
        compiled,
        readFileSync(webRoot + "/src/styles/beeftv-local-overrides.css", "utf8"),
        readFileSync(webRoot + "/src/styles/workspace-product.css", "utf8"),
        ...extraCss,
    ].join("\n");
}
