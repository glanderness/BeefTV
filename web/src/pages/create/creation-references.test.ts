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

test("模型不支持参考图时提示说明原因而不是只留空", () => {
    const plan = planCreationAttachmentAdd([], [attachment("a")], 0);

    assert.equal(plan.attachments.length, 0);
    assert.equal(plan.droppedCount, 1);
    assert.match(attachmentLimitMessage(plan.limit, plan.addedCount, plan.droppedCount), /不支持参考图输入/);
});

test("上限提示同时说清上限、加入数量与未加入数量", () => {
    assert.equal(
        attachmentLimitMessage(9, 2, 3),
        "创作页的 9 个参考内容槽位（取自当前模型的参考图上限），已加入 2 个，另有 3 个未加入",
    );
    assert.equal(attachmentLimitMessage(9, 0, 3), "创作页的 9 个参考内容槽位（取自当前模型的参考图上限）已满，所选 3 个素材未加入");
});

// 视频模型对参考图、参考视频、参考音频分别计数；创作页却把三类塞进以参考图上限为容量的同一列。
// 提示必须说成创作页槽位，否则用户会以为模型不允许再加视频而白删素材或换模型。
test("点添加参考内容触发的提示不把参考图上限说成模型对全部素材的上限", () => {
    const message = referenceSlotLimitMessage(9, { videos: 3, audios: 3 });

    assert.match(message, /创作页一次最多放入 9 个参考内容/);
    assert.match(message, /槽位取自当前模型的参考图上限/);
    assert.match(message, /参考视频 3 个/);
    assert.match(message, /参考音频 3 段/);
    assert.doesNotMatch(message, /当前模型最多支持 9 个参考内容/);
});

test("自动移除超出槽位的素材时也说明是创作页槽位", () => {
    assert.equal(
        attachmentRemovalMessage(9, 2),
        "创作页的 9 个参考内容槽位（取自当前模型的参考图上限）已满，已移除 2 个超出槽位的素材",
    );
    assert.equal(attachmentRemovalMessage(0, 2), "当前模型不支持参考图输入，已移除 2 个素材");
});
