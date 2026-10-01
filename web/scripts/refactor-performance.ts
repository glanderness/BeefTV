import { execFileSync } from "node:child_process";
import { buildCanvasSpatialIndex, canvasNodeBounds } from "../src/lib/canvas/canvas-spatial-index";

// Deterministic CPU-only baseline. This does not measure React frames, SQLite,
// resource decoding, or end-to-end save latency; those need separate fixtures.
const samples = 21;
function measure(run: () => unknown) {
    for (let i = 0; i < 3; i++) run();
    const durations = Array.from({ length: samples }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((a, b) => a - b);
    return { medianMs: durations[Math.floor(samples / 2)], p95Ms: durations[Math.ceil(samples * 0.95) - 1] };
}

const results = [1000, 10000, 50000].map((nodeCount) => {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        id: `node-${index}`,
        type: index % 50 < 35 ? "image" : index % 50 < 49 ? "video" : "text",
        title: `节点 ${index}`,
        position: { x: (index % 250) * 360, y: Math.floor(index / 250) * 220 },
        width: 320,
        height: 180,
        metadata: { resourceId: `fixture-${index}` },
    }));
    const document = { id: "performance-fixture", nodes, connections: [], chatSessions: [] };
    const serialized = JSON.stringify(document);
    const entries = nodes.map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node.id }));
    const spatial = buildCanvasSpatialIndex(entries);
    return {
        nodeCount,
        serializedBytes: Buffer.byteLength(serialized),
        serialize: measure(() => JSON.stringify(document)),
        parse: measure(() => JSON.parse(serialized)),
        buildSpatialIndex: measure(() => buildCanvasSpatialIndex(entries)),
        query500Viewports: measure(() => {
            for (let i = 0; i < 500; i++) {
                const x = (i % 100) * 180;
                const y = Math.floor(i / 100) * 220;
                spatial.query({ left: x, top: y, right: x + 1600, bottom: y + 900 }, 720);
            }
        }),
    };
});

console.log(JSON.stringify({
    fixtureVersion: 1,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    measuredAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}/${process.arch}`,
    samples,
    warmup: 3,
    results,
}, null, 2));
