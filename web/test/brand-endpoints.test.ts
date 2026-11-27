import { expect, test } from "bun:test";
import { isBeefTVEndpoint } from "../src/lib/beeftv-video-contracts";
import { beefTVConnectionLabel } from "../src/services/api/beeftv-connection";
import { channelRequest } from "../src/services/api/custom-channel-relay";

test("both brands retain strict managed endpoint recognition and relay credentials", () => {
    for (const baseUrl of ["https://beeftv.cn", "https://beeftv.app"]) {
        expect(isBeefTVEndpoint(baseUrl + "/v1")).toBe(true);
        const request = channelRequest({baseUrl, apiKey: "", apiFormat: "openai", credentialRef: "beeftv"}, baseUrl + "/v1/models");
        expect(request.url).toContain("/ai/custom");
        expect(JSON.stringify(request)).not.toContain("Bearer ");
    }
    for (const invalidUrl of ["https://legacy-enterprise.example.com", "http://beeftv.cn", "http://beeftv.app", "https://beeftv.cn:444", "https://beeftv.app:444", "https://beeftv.cn.evil.test", "https://beeftv.app.evil.test", "https://user@beeftv.cn", "https://user@beeftv.app", "https://evil.test/beeftv.cn", "https://evil.test/beeftv.app"]) {
        expect(isBeefTVEndpoint(invalidUrl)).toBe(false);
    }
});

test("connected identity prefers email over display name and username", () => {
    expect(beefTVConnectionLabel({state: "connected", account: {id: "1", email: "creator@example.com", display_name: "Creator", username: "legacy"}})).toBe("已连接 creator@example.com");
});
