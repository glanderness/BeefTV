import { useEffect, useRef, useState } from "react";
import { App, Button } from "antd";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { downloadGenerationOutput, readGenerationOutputBlob } from "@/services/generation-output-media";
import { isWailsNativeShell } from "@/services/desktop-media-save";
import type { GenerationOutput } from "@/lib/generation-outputs";
import type { CanvasNodeData } from "@/types/canvas";
import { useCanvasNodeActions } from "./canvas-node-action-context";

export function CanvasGenerationResults({ node }: { node: CanvasNodeData }) {
    const [open, setOpen] = useState(false);
    const [previewId, setPreviewId] = useState<string>();
    const { message } = App.useApp();
    const [applying, setApplying] = useState<string>();
    const requestRef = useRef<AbortController | null>(null);
    useEffect(() => () => requestRef.current?.abort(), []);
    const { selectGenerationOutput, addGenerationOutputs } = useCanvasNodeActions();
    const apply = async (key: string, action: (signal: AbortSignal) => Promise<void>) => {
        if (requestRef.current) return;
        const request = new AbortController();
        requestRef.current = request;
        setApplying(key);
        try {
            await action(request.signal);
        } catch (error) {
            if (!request.signal.aborted) message.error(error instanceof Error ? error.message : "结果添加失败，请重试");
        } finally {
            if (!request.signal.aborted) setApplying(undefined);
            requestRef.current = null;
        }
    };
    const outputs = node.metadata?.generationOutputs || [];
    if (!outputs.length) return null;
    const preview = outputs.find((item) => item.id === previewId) || outputs.find((item) => item.id === node.metadata?.primaryOutputId) || outputs[0];
    return <>
        <Button size="small" className="absolute bottom-2 right-2 z-[var(--node-z-overlay)]" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>结果 · {outputs.length}</Button>
        <AppDrawer title={`生成结果 · ${outputs.length}`} open={open} onClose={() => setOpen(false)} size={480}>
            <div className="flex flex-col gap-4 text-foreground" data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                {open ? <OutputPreview key={preview.id} output={preview} /> : null}
                <p className="text-xs" style={{ color: "var(--workspace-text-muted)" }}>切换预览不会改变画布连接。设为主输出后，下游使用当前节点的新结果；添加到画布可单独连接其他输出。</p>
                {outputs.map((output) => {
                    const primary = output.id === node.metadata?.primaryOutputId;
                    return <div key={output.id} className="flex flex-col gap-2 rounded-lg p-3" style={{ background: "var(--card-surface)" }}>
                        <button type="button" className="text-left text-sm" aria-pressed={preview.id === output.id} onClick={() => setPreviewId(output.id)}>输出 {output.outputIndex + 1} · {output.mediaType === "video" ? "视频" : output.mediaType === "audio" ? "音频" : output.mediaType === "image" ? "图片" : "文件"}{output.sourceNodeId ? ` · 节点 ${output.sourceNodeId}` : ""}{primary ? " · 主输出" : ""}</button>
                        <div className="flex flex-wrap gap-2">
                            {output.mediaType === node.type && selectGenerationOutput ? <Button size="small" disabled={primary || !!applying} loading={applying === `primary:${output.id}`} onClick={() => void apply(`primary:${output.id}`, (signal) => selectGenerationOutput(node, output, signal))}>设为主输出</Button> : null}
                            {output.mediaType !== "file" && addGenerationOutputs ? <Button size="small" disabled={!!applying} loading={applying === `add:${output.id}`} onClick={() => void apply(`add:${output.id}`, (signal) => addGenerationOutputs(node, [output], signal))}>添加到画布</Button> : null}
                            <OutputDownload output={output} />
                        </div>
                    </div>;
                })}
                {addGenerationOutputs ? <Button disabled={!!applying} loading={applying === "all"} onClick={() => void apply("all", (signal) => addGenerationOutputs(node, outputs, signal))}>将全部媒体添加到画布</Button> : null}
            </div>
        </AppDrawer>
    </>;
}

function outputURL(output: GenerationOutput) {
    const resourceId = resourceIdFromStorageKey(output.storageKey);
    return resourceId ? resourceFileUrl(resourceId) : output.dataUrl || output.url || "";
}

function OutputPreview({ output }: { output: GenerationOutput }) {
    if (output.mediaType === "video") return <OutputVideoPreview output={output} />;
    if (output.mediaType === "image") return <CachedResourceImage className="max-h-72 w-full object-contain" src={outputURL(output)} storageKey={output.storageKey} alt={`输出 ${output.outputIndex + 1}`} />;
    if (output.mediaType === "audio") return <OutputAudioPreview output={output} />;
    return <p className="text-sm">{output.mimeType || "文件"} · 请下载查看</p>;
}

function OutputDownload({ output }: { output: GenerationOutput }) {
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const download = async () => {
        if (controller.current) return;
        const request = new AbortController();
        controller.current = request;
        setLoading(true);
        try {
            const result = await downloadGenerationOutput(output, request.signal);
            if (!request.signal.aborted && result === "saved" && isWailsNativeShell()) message.success("已保存到所选位置");
        } catch (error) {
            if (!request.signal.aborted) message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            if (!request.signal.aborted) setLoading(false);
            controller.current = null;
        }
    };
    return <Button size="small" loading={loading} onClick={() => void download()}>下载</Button>;
}

function OutputAudioPreview({ output }: { output: GenerationOutput }) {
    const [state, setState] = useState({ identity: "", url: "", loading: true, error: "" });
    const [retry, setRetry] = useState(0);
    const [scopeEpoch, setScopeEpoch] = useState(getActiveUserScopeEpoch);
    const identity = JSON.stringify([output.storageKey, output.dataUrl, output.url, scopeEpoch]);
    useEffect(() => subscribeUserScope((epoch) => setScopeEpoch(epoch.generation)), []);
    useEffect(() => {
        const controller = new AbortController();
        let ownedUrl = "";
        setState({ identity, url: "", loading: true, error: "" });
        void readGenerationOutputBlob(output, controller.signal).then((blob) => {
            if (controller.signal.aborted) return;
            ownedUrl = URL.createObjectURL(blob);
            setState({ identity, url: ownedUrl, loading: false, error: "" });
        }).catch((error) => {
            if (!controller.signal.aborted) setState({ identity, url: "", loading: false, error: error instanceof Error ? error.message : "音频读取失败" });
        });
        return () => { controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
    }, [output, identity, retry]);
    const current = state.identity === identity;
    return <div>
        {current && state.url ? <audio controls src={state.url} className="w-full" onError={() => setState((state) => ({ ...state, error: "音频暂时无法播放，请重新读取" }))} /> : null}
        {!current || state.loading ? <p role="status">正在读取音频…</p> : null}
        {current && state.error ? <div role="alert">{state.error}<Button size="small" onClick={() => setRetry((value) => value + 1)}>重新读取</Button></div> : null}
    </div>;
}

function OutputVideoPreview({ output }: { output: GenerationOutput }) {
    const playback = useResourceVideoPlayback(output.storageKey || "", outputURL(output));
    return <div>
        {playback.url ? <video key={`${playback.url}:${playback.retryEpoch}`} controls playsInline preload="auto" src={playback.url} className="max-h-72 w-full" onError={() => { if (!playback.requestCompatible()) playback.fail(); }} /> : null}
        {playback.loading ? <p role="status">正在读取视频…</p> : null}
        {playback.error ? <div role="alert">{playback.error}<Button size="small" onClick={playback.retry}>重新读取</Button></div> : null}
    </div>;
}
