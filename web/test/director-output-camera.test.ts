import { expect, test } from "bun:test";

import { waitForDirectorCaptureCamera } from "../src/lib/canvas/director/director-output-camera";

test("输出须等活动机位接管渲染并稳定一帧才开始录制", async () => {
    let camera: "free" | "camera" | null = "free";
    let frames = 0;
    await waitForDirectorCaptureCamera(() => camera, async () => {
        frames += 1;
        if (frames === 2) camera = "camera";
    });
    expect(frames).toBe(3);
});

test("无有效机位时不录制导演观察视角", async () => {
    let frames = 0;
    await expect(waitForDirectorCaptureCamera(() => "free", async () => { frames += 1; }, 3)).rejects.toThrow("没有可用机位");
    expect(frames).toBe(3);
});
