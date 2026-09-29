import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const testFilePattern = /\.test\.[cm]?[jt]sx?$/;
const browserGlobalName = /\b(?:window|document|navigator)\b/;

function collectTestFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectTestFiles(path);
        return testFilePattern.test(entry.name) ? [relative(root, path)] : [];
    });
}

function run(files) {
    if (files.length === 0) return;
    const result = Bun.spawnSync([process.execPath, "test", ...files], {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

const files = [...collectTestFiles(join(root, "test")), ...collectTestFiles(join(root, "src"))].sort();
const isolated = files.filter((file) => {
    const source = readFileSync(join(root, file), "utf8");
    if (source.includes("globalThis") && browserGlobalName.test(source)) return true;
    // mock.module 是进程级依赖替换：与其他文件共享进程会静默改变它们的依赖，
    // 因此这类文件必须单独运行，失败才会落在真正做替换的那个文件上。
    return source.includes("mock.module(");
});
const shared = files.filter((file) => !isolated.includes(file));

run(shared);
for (const file of isolated) run([file]);
