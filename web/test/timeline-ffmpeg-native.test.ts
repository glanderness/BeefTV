import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildTimelineRenderPlan } from "../src/lib/timeline/timeline-to-ffmpeg";
import { executeTimelineRenderPlan, type TimelineRenderEngine } from "../src/lib/timeline/timeline-render-service";
import { isSubtitleFontFailure } from "../src/lib/timeline/subtitle-font-failure";
import type { TimelineProject, TimelineClip } from "../src/types/timeline";
import { rasterizeTimelineSubtitle } from "../src/lib/timeline/timeline-subtitle-image";

function createNativeEngine(dir: string): TimelineRenderEngine {
    return {
        async writeFile(name, data) {
            writeFileSync(join(dir, name), typeof data === "string" ? data : Buffer.from(data));
        },
        async readFile(name) {
            return readFileSync(join(dir, name));
        },
        async deleteFile(name) {
            try { rmSync(join(dir, name)); } catch { /* owned temp dir */ }
        },
        async exec(args) {
            const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
            return { exitCode: result.status ?? 1, log: result.stderr.toString() };
        },
    };
}

test("native/wasm encoder fixture is opt-in; absent runtime is skipped instead of false-green", () => {
    if (process.env.BEEFTV_NATIVE_FFMPEG_TEST === "1") {
        expect(spawnSync("ffmpeg", ["-version"]).status).toBe(0);
        expect(spawnSync("ffprobe", ["-version"]).status).toBe(0);
    }
});

// Opt-in real local encoder test, not browser E2E. No network or paid media.
test.skipIf(process.env.BEEFTV_NATIVE_FFMPEG_TEST !== "1")("native FFmpeg: three clips, original audio, voice, BGM and Chinese subtitles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-timeline-fixture-"));
    const run = (args: string[]) => {
        const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.stderr.toString());
        return result;
    };
    try {
        for (const [index, color] of ["red", "green", "blue"].entries()) {
            run(["-f", "lavfi", "-i", `color=${color}:s=320x180:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", `v${index}.mp4`]);
        }
        for (const [name, frequency] of [["voice", 440], ["bgm", 880]] as const) run(["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=6`, `${name}.wav`]);
        const clips: TimelineClip[] = [0, 1, 2].map((index) => ({ id: `v${index}`, nodeId: `v${index}`, kind: "video", trackId: "v", startMs: index * 2000, durationMs: 2000 }));
        clips.push({ id: "voice", nodeId: "voice", kind: "audio", trackId: "voice", startMs: 1000, durationMs: 2000, sourceStartMs: 500 });
        clips.push({ id: "bgm", nodeId: "bgm", kind: "audio", trackId: "bgm", startMs: 0, durationMs: 6000, volume: 0.2 });
        clips.push({ id: "sub", nodeId: "sub", kind: "subtitle", trackId: "sub", startMs: 500, durationMs: 5000, text: "中文字幕完整性验证" });
        const project: TimelineProject = { version: 2, tracks: [], clips, durationMs: 6000 };
        const sources = clips.filter((clip) => clip.kind !== "subtitle").map((clip) => ({ nodeId: clip.nodeId, fileName: `${clip.nodeId}.${clip.kind === "video" ? "mp4" : "wav"}`, durationMs: 6000, hasAudio: true }));
        const render = async (name: string, subtitleImages?: string[]) => {
            const plan = buildTimelineRenderPlan(project, sources, { width: 320, height: 180, fps: 30, outputName: name, subtitleImages });
            expect(plan.request.audioClipIds).toContain("voice");
            expect(plan.request.subtitleClipIds.length).toBeGreaterThan(0);
            const result = await executeTimelineRenderPlan({ plan, timeline: project, engine: createNativeEngine(dir) });
            expect(result.subtitleBurned).toBe(true);
            expect(result.mixedAudio).toBe(true);
        };
        const spectrum = (name: string, start: number, frequency: number) => {
            const result = run(["-ss", String(start), "-i", name, "-t", "0.5", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
            const values = new Float32Array(result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.length));
            let re = 0, im = 0;
            for (let i = 0; i < values.length; i++) { re += values[i] * Math.cos(2 * Math.PI * frequency * i / 8000); im += values[i] * Math.sin(2 * Math.PI * frequency * i / 8000); }
            return Math.hypot(re, im) / values.length;
        };
        await render("out.mp4");
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "out.mp4"], { cwd: dir });
        expect(Math.abs(Number(probe.stdout.toString()) - 6)).toBeLessThan(0.1);
        for (const [index, start] of [0.2, 2.2, 4.2].entries()) {
            const pixel = run(["-ss", String(start), "-i", "out.mp4", "-frames:v", "1", "-vf", "crop=2:2:0:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout;
            expect(pixel[index]).toBeGreaterThan(pixel[(index + 1) % 3] + 60);
        }
        for (const start of [0.2, 1.3, 3.5, 5.2]) {
            expect(spectrum("out.mp4", start, 220)).toBeGreaterThan(0.03);
            expect(spectrum("out.mp4", start, 880)).toBeGreaterThan(0.005);
        }
        expect(spectrum("out.mp4", 1.3, 440)).toBeGreaterThan(0.03);
        expect(spectrum("out.mp4", 0.2, 440)).toBeLessThan(0.002);
        expect(spectrum("out.mp4", 3.5, 440)).toBeLessThan(0.002);
        const frame = (name: string) => run(["-ss", "1", "-i", name, "-frames:v", "1", "-vf", "crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).stdout;
        const withText = frame("out.mp4"), withoutText = frame("timeline-mixed.mp4");
        expect(withText.some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        // Actual headless Chrome fonts and Canvas2D, then the same overlay plan used by wasm.
        const { chromium } = await import("playwright");
        const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
        const browser = await chromium.launch({ executablePath, headless: true });
        try {
            const page = await browser.newPage();
            await page.addScriptTag({ content: `window.rasterize = ${rasterizeTimelineSubtitle.toString()}` });
            const png = await page.evaluate(async () => Array.from(await (window as any).rasterize("中文字幕完整性验证", 320, 180)));
            writeFileSync(join(dir, "subtitle.png"), Buffer.from(png as number[]));
            const glyphs = await page.evaluate(async () => [Array.from(await (window as any).rasterize("中文", 320, 180)), Array.from(await (window as any).rasterize("测试", 320, 180))]);
            expect(glyphs[0]).not.toEqual(glyphs[1]);
        } finally { await browser.close(); }
        await render("browser-fonts.mp4", ["subtitle.png"]);
        expect(frame("browser-fonts.mp4").some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        const outside = (name: string, time: string) => run(["-ss", time, "-i", name, "-frames:v", "1", "-vf", "crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).stdout;
        for (const time of ["0.2", "5.7"]) {
            const actual = outside("browser-fonts.mp4", time), baseline = outside("timeline-mixed.mp4", time);
            expect(actual.some((value, index) => Math.abs(value - baseline[index]) > 80)).toBe(false);
        }
        // Exercise the shipped wasm binary itself (Node host, not browser Worker E2E).
        const globals = globalThis as any;
        const previousSelf = globals.self, previousImportScripts = globals.importScripts;
        globals.self = { location: { href: "file:///tmp/ffmpeg-core.js" } };
        globals.importScripts = () => undefined;
        try {
            const coreUrl = new URL("../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", import.meta.url);
            const { default: createCore } = await import(coreUrl.href);
            const core = await createCore({ wasmBinary: readFileSync(new URL("ffmpeg-core.wasm", coreUrl)) });
            const plan = buildTimelineRenderPlan(project, sources, { width: 320, height: 180, outputName: "wasm.mp4", subtitleImages: ["subtitle.png"] });
            for (const name of [...sources.map((source) => source.fileName), "subtitle.png", "timeline.srt", "concat.txt"]) core.FS.writeFile(name, readFileSync(join(dir, name)));
            let log = "";
            core.setLogger(({ message }: { message: string }) => { log = (log + "\n" + message).slice(-4000); });
            for (const source of sources) {
                core.reset();
                core.FS.writeFile("probe.json", new Uint8Array());
                core.ffprobe("-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", source.fileName, "-o", "probe.json");
                expect([0, -1]).toContain(core.ret);
                const probe = JSON.parse(new TextDecoder().decode(core.FS.readFile("probe.json")));
                expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(2);
                expect(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
            }
            for (const step of plan.steps) if (step.args.length) {
                core.reset();
                core.exec(...step.args);
                if (core.ret !== 0 || (step.kind === "burn" && isSubtitleFontFailure(log))) throw new Error(`wasm ${step.description}: ${log}`);
            }
            writeFileSync(join(dir, "wasm.mp4"), core.FS.readFile("wasm.mp4"));
            expect(spectrum("wasm.mp4", 1.3, 220)).toBeGreaterThan(0.03);
            expect(spectrum("wasm.mp4", 1.3, 440)).toBeGreaterThan(0.03);
            expect(spectrum("wasm.mp4", 1.3, 880)).toBeGreaterThan(0.005);
            expect(spectrum("wasm.mp4", 3.5, 440)).toBeLessThan(0.002);
            expect(frame("wasm.mp4").some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        } finally { globals.self = previousSelf; globals.importScripts = previousImportScripts; }
        clips.find((clip) => clip.id === "voice")!.volume = 0;
        project.tracks = [{ id: "bgm", kind: "audio", label: "BGM", order: 1, muted: true }];
        await render("muted.mp4");
        expect(spectrum("muted.mp4", 1.3, 220)).toBeGreaterThan(0.03);
        expect(spectrum("muted.mp4", 1.3, 440)).toBeLessThan(0.002);
        expect(spectrum("muted.mp4", 1.3, 880)).toBeLessThan(0.002);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
