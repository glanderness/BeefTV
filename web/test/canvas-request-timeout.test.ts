import { describe, expect, test } from "bun:test";
import type { InternalAxiosRequestConfig } from "axios";
import { apiClient, http } from "../src/services/api/request";

describe("canvas document read and default request timeouts", () => {
    test("canvas project reads get a generous timeout while apiClient default stays 4000ms for lightweight probes", async () => {
        expect(apiClient.defaults.timeout).toBe(4_000);
        const captured: Array<{ method?: string; url?: string; timeout?: number }> = [];
        const prevAdapter = apiClient.defaults.adapter;
        apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
            captured.push({ method: config.method, url: config.url, timeout: config.timeout });
            return {
                data: { code: 0, data: { ok: true }, msg: "ok" },
                status: 200,
                statusText: "OK",
                headers: {},
                config,
            };
        };
        try {
            await http.get("/canvas-projects/large-canvas-1");
            await http.get("/canvas-projects/large-canvas-1/history");
            await http.get("/canvas-projects/large-canvas-1/history/snap-99");
            await http.post("/ops/canvas.get", { id: "large-canvas-1" });
            await http.get("/canvas-projects");
            await http.get("/health");
            await http.put("/canvas-projects/large-canvas-1", { nodes: [] });
        } finally {
            apiClient.defaults.adapter = prevAdapter;
        }

        const getCanvas = captured.find((item) => item.method === "get" && item.url === "/canvas-projects/large-canvas-1");
        const getHistory = captured.find((item) => item.method === "get" && item.url === "/canvas-projects/large-canvas-1/history");
        const getSnapshot = captured.find((item) => item.method === "get" && item.url === "/canvas-projects/large-canvas-1/history/snap-99");
        const opsCanvasGet = captured.find((item) => item.method === "post" && item.url === "/ops/canvas.get");
        const listCanvases = captured.find((item) => item.method === "get" && item.url === "/canvas-projects");
        const health = captured.find((item) => item.method === "get" && item.url === "/health");
        const writeCanvas = captured.find((item) => item.method === "put" && item.url === "/canvas-projects/large-canvas-1");

        expect(getCanvas?.timeout).toBeGreaterThanOrEqual(30_000);
        expect(getHistory?.timeout).toBeGreaterThanOrEqual(30_000);
        expect(getSnapshot?.timeout).toBeGreaterThanOrEqual(30_000);
        expect(opsCanvasGet?.timeout).toBeGreaterThanOrEqual(30_000);
        expect(listCanvases?.timeout).toBe(4_000);
        expect(health?.timeout).toBe(4_000);
        expect(writeCanvas?.timeout).toBe(180_000);
    });
});
