import { describe, expect, test } from "bun:test";

import {
    assertExtractableAudioBuffer,
    buildExtractedAudioFileName,
    decodeAudioBufferFromVideoBlob,
    encodeAudioBufferToWav,
    extractVideoAudioToCanvasNode,
    NO_VIDEO_AUDIO_TRACK_MESSAGE,
    type DecodedAudioLike,
} from "@/lib/canvas/extract-video-audio";
import type { RemoteResource, ResourceUploadMeta } from "@/services/api/resources";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function makeSineBuffer(options?: {
    channels?: number;
    sampleRate?: number;
    durationSeconds?: number;
    amplitude?: number;
}): DecodedAudioLike {
    const numberOfChannels = options?.channels ?? 2;
    const sampleRate = options?.sampleRate ?? 16000;
    const durationSeconds = options?.durationSeconds ?? 0.25;
    const amplitude = options?.amplitude ?? 0.5;
    const length = Math.round(sampleRate * durationSeconds);
    const dataByChannel = Array.from({ length: numberOfChannels }, (_, ch) => {
        const samples = new Float32Array(length);
        const freq = 440 + ch * 110;
        for (let i = 0; i < length; i += 1) {
            samples[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
        }
        return samples;
    });
    return {
        numberOfChannels,
        length,
        sampleRate,
        getChannelData: (channel: number) => dataByChannel[channel] || new Float32Array(0),
    };
}

describe("extract-video-audio WAV encoding and silent/missing audio detection", () => {
    test("encodes valid stereo 16-bit PCM RIFF WAVE binary and downsamples high sample rates cleanly", async () => {
        const stereo = makeSineBuffer({ channels: 2, sampleRate: 16000, durationSeconds: 0.1 });
        const wavBlob = encodeAudioBufferToWav(stereo);
        expect(wavBlob.type).toBe("audio/wav");

        const bytes = await wavBlob.arrayBuffer();
        const view = new DataView(bytes);
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
        expect(magic).toBe("RIFF");
        expect(wave).toBe("WAVE");
        expect(view.getUint16(20, true)).toBe(1); // PCM format
        expect(view.getUint16(22, true)).toBe(2); // 2 channels
        expect(view.getUint32(24, true)).toBe(16000); // sampleRate
        expect(view.getUint16(34, true)).toBe(16); // 16-bit
        expect(view.getUint32(40, true)).toBe(1600 * 2 * 2);
        expect(bytes.byteLength).toBe(44 + 1600 * 2 * 2);

        const highRate = makeSineBuffer({ channels: 2, sampleRate: 48000, durationSeconds: 0.2 });
        const downsampled = encodeAudioBufferToWav(highRate, { maxSampleRate: 16000 });
        const downView = new DataView(await downsampled.arrayBuffer());
        expect(downView.getUint32(24, true)).toBe(16000);
    });

    test("rejects silent zero-amplitude audio buffers and EncodingError video blobs with clear user message", async () => {
        const silent = makeSineBuffer({ amplitude: 0 });
        expect(() => assertExtractableAudioBuffer(silent)).toThrow(NO_VIDEO_AUDIO_TRACK_MESSAGE);

        let closed = false;
        await expect(
            decodeAudioBufferFromVideoBlob(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" }), {
                createAudioContext: () => ({
                    decodeAudioData: async () => {
                        throw new DOMException("Unable to decode audio data", "EncodingError");
                    },
                    close: async () => {
                        closed = true;
                    },
                }),
            }),
        ).rejects.toThrow(NO_VIDEO_AUDIO_TRACK_MESSAGE);
        expect(closed).toBe(true);
    });

    test("extractVideoAudioToCanvasNode uploads WAV via uploadResourceFile and creates a right-hand Audio node + edge", async () => {
        const sourceVideo: CanvasNodeData = {
            id: "video-src-1",
            type: CanvasNodeType.Video,
            title: "角色参考台词.mp4",
            position: { x: 200, y: 300 },
            width: 360,
            height: 202,
            metadata: {
                content: "https://example.com/source.mp4",
                storageKey: "resource:vid-123",
            },
        };

        const uploadCalls: Array<{ file: File; kind: string; meta?: ResourceUploadMeta }> = [];
        const result = await extractVideoAudioToCanvasNode(sourceVideo, [sourceVideo], {
            useLocalStore: () => false,
            resolveVideoBlob: async () => new Blob([new Uint8Array([0, 1, 2, 3])], { type: "video/mp4" }),
            createAudioContext: () => ({
                decodeAudioData: async () => makeSineBuffer({ channels: 1, sampleRate: 16000, durationSeconds: 1.5 }),
                close: async () => undefined,
            }),
            uploadAudioResource: async (file, kind, meta) => {
                uploadCalls.push({ file, kind, meta });
                return {
                    id: "res-audio-99",
                    kind: "audio",
                    mimeType: "audio/wav",
                    size: file.size,
                    durationMs: meta?.durationMs,
                    createdAt: new Date().toISOString(),
                } as RemoteResource;
            },
        });

        expect(buildExtractedAudioFileName("角色参考台词.mp4")).toBe("角色参考台词-audio.wav");
        expect(uploadCalls).toHaveLength(1);
        expect(uploadCalls[0].kind).toBe("audio");
        expect(uploadCalls[0].file.name).toBe("角色参考台词-audio.wav");
        expect(uploadCalls[0].file.type).toBe("audio/wav");
        expect(uploadCalls[0].meta?.durationMs).toBe(1500);
        expect(Boolean(uploadCalls[0].meta?.idempotencyKey)).toBe(true);

        expect(result.audioNode.type).toBe(CanvasNodeType.Audio);
        expect(result.audioNode.position.x).toBeGreaterThan(sourceVideo.position.x + sourceVideo.width);
        expect(result.audioNode.metadata?.storageKey).toBe("resource:res-audio-99");
        expect(result.audioNode.metadata?.mimeType).toBe("audio/wav");
        expect(result.audioNode.metadata?.durationMs).toBe(1500);
        expect(result.audioNode.metadata?.audioExtractSourceNodeId).toBe(sourceVideo.id);
        expect(result.connection.fromNodeId).toBe(sourceVideo.id);
        expect(result.connection.toNodeId).toBe(result.audioNode.id);
    });
});
