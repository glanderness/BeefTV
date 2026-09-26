import { expect, test } from "bun:test";

import { generationErrorMessage } from "../src/lib/generation-error";

test("local generation errors do not expose hosted object-storage wording", () => {
    expect(generationErrorMessage("OSS 上传失败：对象存储不可用")).toBe("本地参考素材保存失败，请检查本地资源目录后重试");
    expect(generationErrorMessage("参考图片上传失败")).toBe("本地参考素材保存失败，请检查本地资源目录后重试");
});
