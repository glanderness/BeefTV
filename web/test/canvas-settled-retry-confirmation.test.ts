import { expect, test } from "bun:test";

// 「提交结果未确认 + 原任务已终态」的节点：取不回原结果之后，新建任务前必须弹付费确认。
// 判定要同时认任务侧的两份证据（stage=submission_unknown、错误码 submission_uncertain），
// 否则会出现「自动取回被拒 → 点重新生成 → 没确认就新建任务」。
test("settled submission-uncertain retries confirm before creating a task", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/canvas-settled-retry-confirmation.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: settled submission-uncertain retries always confirm before creating a task");
}, 20000);
