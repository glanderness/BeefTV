import assert from "node:assert/strict";
import test from "node:test";

// Node 原生 TypeScript 测试运行器要求保留扩展名，项目编译器不允许该写法。
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { attachmentLimitMessage, attachmentRemovalMessage, planCreationAttachmentAdd, referenceSlotLimitMessage } from "./creation-references.ts";

function attachment(id: string) {
    return { id, previewUrl: `blob:${id}` } as never;
}

test("未到上限时素材全部加入，不报告被丢弃的数量", () => {
    const plan = planCreationAttachmentAdd([attachment("a")], [attachment("b"), attachment("c")], 9);

    assert.deepEqual(
        plan.attachments.map((item) => (item as { id: string }).id),
        ["a", "b", "c"],
    );
    assert.equal(plan.addedCount, 2);
    assert.equal(plan.droppedCount, 0);
});

test("超出上限时保留前面的素材并报告丢弃数量，不再静默裁剪", () => {
    const current = [attachment("a"), attachment("b")];
    const incoming = [attachment("c"), attachment("d"), attachment("e")];
    const plan = planCreationAttachmentAdd(current, incoming, 3);

    assert.deepEqual(
        plan.attachments.map((item) => (item as { id: string }).id),
        ["a", "b", "c"],
    );
    assert.equal(plan.addedCount, 1);
    assert.equal(plan.droppedCount, 2);
});

test("已达上限时所有新素材都被报告为未加入", () => {
    const current = [attachment("a"), attachment("b"), attachment("c")];
    const plan = planCreationAttachmentAdd(current, [attachment("d")], 3);

    assert.deepEqual(
        plan.attachments.map((item) => (item as { id: string }).id),
        ["a", "b", "c"],
    );
    assert.equal(plan.addedCount, 0);
    assert.equal(plan.droppedCount, 1);
});

test("重复选择的同一素材只占一个位置", () => {
    const plan = planCreationAttachmentAdd([attachment("a")], [attachment("a"), attachment("b")], 9);

    assert.deepEqual(
        plan.attachments.map((item) => (item as { id: string }).id),
        ["a", "b"],
    );
    assert.equal(plan.addedCount, 1);
    assert.equal(plan.droppedCount, 0);
});

test("模型不支持参考内容时提示说明原因而不是只留空", () => {
    const plan = planCreationAttachmentAdd([], [attachment("a")], 0);

    assert.equal(plan.attachments.length, 0);
    assert.equal(plan.droppedCount, 1);
    assert.match(attachmentLimitMessage(plan.limit, plan.addedCount, plan.droppedCount), /不支持参考内容/);
});

test("上限提示同时说清上限、加入数量与未加入数量", () => {
    assert.equal(
        attachmentLimitMessage(9, 2, 3),
        "创作页最多放入 9 个参考内容，已加入 2 个，另有 3 个未加入",
    );
    assert.equal(attachmentLimitMessage(9, 0, 3), "创作页最多放入 9 个参考内容已满，所选 3 个素材未加入");
});

// 文字模式的 6 个参考内容是创作页固定容量，与模型能力无关；提示不能声称它来自模型，
// 也不能建议换模型（换模型并不能提高文字模式的容量）。
test("文字模式跑满 6 个时提示只讲页面容量，不声称源自模型也不建议换模型", () => {
    assert.equal(
        referenceSlotLimitMessage(6),
        "创作页最多放入 6 个参考内容，已达上限；请先移除部分参考内容再添加",
    );
    assert.equal(
        attachmentLimitMessage(6, 0, 2),
        "创作页最多放入 6 个参考内容已满，所选 2 个素材未加入",
    );

    const messages = [referenceSlotLimitMessage(6), attachmentLimitMessage(6, 1, 2), attachmentRemovalMessage(6, 2)];
    for (const message of messages) {
        assert.doesNotMatch(message, /参考图上限/);
        assert.doesNotMatch(message, /模型侧|按类型分别计数/);
        assert.doesNotMatch(message, /切换到.*模型|换模型/);
    }
});

test("提示只给出当前有效的下一步，不解释上限来源", () => {
    const message = referenceSlotLimitMessage(9);

    assert.match(message, /请先移除部分参考内容再添加/);
    assert.doesNotMatch(message, /槽位|取自|参考图上限/);
});

test("自动移除超限素材时也说明是页面容量", () => {
    assert.equal(
        attachmentRemovalMessage(9, 2),
        "创作页最多放入 9 个参考内容已满，已移除 2 个超出上限的素材",
    );
    assert.equal(attachmentRemovalMessage(0, 2), "当前模型不支持参考内容，已移除 2 个素材");
});
