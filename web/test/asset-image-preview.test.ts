import { afterEach, expect, test } from "bun:test";

import { apiClient } from "../src/services/api/request";
import { getResourceBlob } from "../src/services/api/resources";

const originalGet = apiClient.get;

afterEach(() => {
    apiClient.get = originalGet;
});

test("image preview fetches the full resource through the authenticated media client", async () => {
    const image = new Blob(["image-bytes"], { type: "image/png" });
    let requestUrl = "";
    let requestConfig: Record<string, unknown> | undefined;
    apiClient.get = (async (url, config) => {
        requestUrl = url;
        requestConfig = config as Record<string, unknown>;
        return { data: image };
    }) as typeof apiClient.get;

    await expect(getResourceBlob("resource:image 1")).resolves.toBe(image);
    expect(requestUrl).toBe("/resources/image%201/file?proxy=1");
    expect(requestConfig).toMatchObject({ responseType: "blob", timeout: 0 });
});
