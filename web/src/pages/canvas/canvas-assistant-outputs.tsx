import { Button, Tooltip } from "antd";
import { ChevronRight, Download, FileArchive, Film, Play, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getActiveUserScope, getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { getResourceBlob, getResourcePlaybackBlob, resourceStorageKey } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia, isWailsNativeShell } from "@/services/desktop-media-save";
import type { AssistantTurnOutput } from "@/services/api/agent-assistant";

const Player = lazy(() => import("@/components/video-player").then(module => ({ default: module.VideoPlayer })));

export function assistantOutputResource(task: GenerationTask | undefined): string | null {
    if (task?.status !== "succeeded" || !task.resultJson) return null;
    try {
        const result = JSON.parse(task.resultJson);
        return typeof result?.resourceId === "string" && result.resourceId.trim() ? result.resourceId.trim() : null;
    } catch { return null; }
}

export function CanvasAssistantOutputs({ outputs }: { outputs: AssistantTurnOutput[] }) {
    const unique = [...new Map<string, AssistantTurnOutput>(outputs.map(output => [output.kind === "video" ? `video:${output.taskId}` : `project:${output.resourceId}`, output])).values()];
    const videos = unique.filter((output): output is Extract<AssistantTurnOutput, {kind:"video"}> => output.kind === "video");
    const projects = unique.filter((output): output is Extract<AssistantTurnOutput, {kind:"project"}> => output.kind === "project");
    return <CanvasAssistantVideoOutputs outputs={videos} projects={projects} />;
}

function AssistantProjectDownload({output}: {output: Extract<AssistantTurnOutput,{kind:"project"}>}) {
    const [feedback,setFeedback] = useState("");
    const [loading,setLoading] = useState(false);
    async function download() {
        const scope = captureUserScope(); let url = "";
        setLoading(true);setFeedback("");
        try {
            if (!isWailsNativeShell()) {
                const blob = await getResourceBlob(resourceStorageKey(output.resourceId)); assertUserScope(scope);
                if (!blob) throw Error("missing project"); url=URL.createObjectURL(blob);
            }
            const result = await downloadOwnedOrBrowserMedia({fileName:output.fileName,resourceId:output.resourceId,browserUrl:url || undefined});
            assertUserScope(scope);if(result === "saved")setFeedback("工程已保存，可在 BeefTV 导入后继续编辑");
        } catch { if(userScopeMatches(scope))setFeedback("工程下载未完成，请重试"); }
        finally { setLoading(false);if(url)setTimeout(()=>URL.revokeObjectURL(url),1000); }
    }
    return <div className="canvas-assistant-delivery-project">
        <FileArchive size={15} aria-hidden /><span className="canvas-assistant-delivery-file"><strong title={output.fileName}>{output.fileName}</strong><small>可编辑工程</small></span>
        <Tooltip title="下载工程"><Button type="text" size="small" aria-label={`下载工程 ${output.fileName}`} loading={loading} icon={<Download size={14} />} onClick={()=>void download()} /></Tooltip>
        {feedback ? <span className="canvas-assistant-delivery-feedback" role="status">{feedback}</span> : null}
    </div>;
}

function CanvasAssistantVideoOutputs({ outputs, projects }: { outputs: Extract<AssistantTurnOutput,{kind:"video"}>[]; projects: Extract<AssistantTurnOutput,{kind:"project"}>[] }) {
    const account = useSyncExternalStore(subscribeUserScope, () => JSON.stringify([getActiveUserScope(), getActiveUserScopeEpoch()]), () => "");
    const expected = useMemo(() => captureUserScope(), [account]);
    const signature = JSON.stringify(outputs.map(output => [output.taskId, output.kind, output.sourceRevision]));
    const identity = `${account}:${signature}`;
    const currentIdentity = useRef(identity);
    currentIdentity.current = identity;
    const [records, setRecords] = useState<{ identity: string; tasks: Record<string, GenerationTask>; unread: string[] }>({ identity: "", tasks: {}, unread: [] });
    const [playback, setPlayback] = useState<{ identity: string; taskId: string; url: string; loading?: boolean; error?: boolean } | null>(null);
    const [feedback, setFeedback] = useState<{ identity: string; text: string } | null>(null);
    const ownedURLs = useRef(new Set<string>());
    const playerURL = useRef("");
    const requestSerial = useRef(0);
    const [retry, setRetry] = useState(0);
    const [selected, setSelected] = useState<{ identity: string; taskId: string } | null>(null);
    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const targets = JSON.parse(signature) as [string, string, number?][];
        const read = async () => {
            const entries = await Promise.all(targets.map(async ([taskId]) => {
                try { return [taskId, await queryGenerationTask(taskId, { signal: controller.signal, expectedScope: expected })] as const; }
                catch { return [taskId, null] as const; }
            }));
            if (cancelled || !userScopeMatches(expected)) return;
            const tasks: Record<string, GenerationTask> = {}, unread: string[] = [];
            for (const [id, task] of entries) {
                if (task && task.id === id) tasks[id] = task;
                else unread.push(id);
            }
            setRecords(previous => ({ identity, tasks: { ...(previous.identity === identity ? previous.tasks : {}), ...tasks }, unread }));
            if (entries.some(([, task]) => task?.status === "queued" || task?.status === "running")) timer = setTimeout(() => void read(), 2000);
        };
        void read();
        return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
    }, [identity, signature, expected, retry]);
    useEffect(() => {
        const urls = ownedURLs.current;
        return () => { requestSerial.current++; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); playerURL.current = ""; };
    }, [identity]);
    const tasks = records.identity === identity ? records.tasks : {};
    const shownPlayback = playback?.identity === identity ? playback : null;
    const last = outputs.at(-1);
    const lastReady = last && assistantOutputResource(tasks[last.taskId]);
    const lastTask = last ? tasks[last.taskId] : undefined;
    const lastUnread = Boolean(last && records.identity === identity && records.unread.includes(last.taskId));
    const previousNotice = lastUnread || !lastTask ? "这是之前已完成的版本；后一次合成结果尚未确认。"
        : lastTask.status === "queued" || lastTask.status === "running" ? "这是之前已完成的版本；后一次正在合成。"
        : lastTask.status === "failed" || lastTask.status === "cancelled" ? "这是之前已完成的版本；后一次合成未完成。"
        : lastTask.status === "succeeded" ? "这是之前已完成的版本；后一次成片暂不可用。" : "这是之前已完成的版本；后一次合成结果尚未确认。";
    async function play(taskId: string) {
        const resourceId = assistantOutputResource(tasks[taskId]);
        if (!resourceId) return;
        const serial = ++requestSerial.current;
        setPlayback({ identity, taskId, url: "", loading: true });
        try {
            assertUserScope(expected);
            const blob = await getResourcePlaybackBlob(resourceStorageKey(resourceId));
            assertUserScope(expected);
            if (serial !== requestSerial.current || currentIdentity.current !== identity) return;
            if (!blob) throw Error("missing media");
            const url = URL.createObjectURL(blob);
            if (playerURL.current) { URL.revokeObjectURL(playerURL.current); ownedURLs.current.delete(playerURL.current); }
            playerURL.current = url; ownedURLs.current.add(url);
            setPlayback({ identity, taskId, url });
        } catch {
            if (serial === requestSerial.current && currentIdentity.current === identity && userScopeMatches(expected)) setPlayback({ identity, taskId, url: "", error: true });
        }
    }
    async function download(taskId: string, title: string) {
        const resourceId = assistantOutputResource(tasks[taskId]);
        if (!resourceId) return;
        const serial = requestSerial.current;
        let url = "";
        try {
            assertUserScope(expected);
            if (!isWailsNativeShell()) {
                const blob = await getResourceBlob(resourceStorageKey(resourceId));
                assertUserScope(expected);
                if (serial !== requestSerial.current || currentIdentity.current !== identity) return;
                if (!blob) throw Error("missing media");
                url = URL.createObjectURL(blob);
                ownedURLs.current.add(url);
            }
            const result = await downloadOwnedOrBrowserMedia({ fileName: `${title}.mp4`, resourceId, browserUrl: url || undefined });
            if (result === "saved" && currentIdentity.current === identity && userScopeMatches(expected)) setFeedback({ identity, text: "成片已保存" });
        } catch {
            if (currentIdentity.current === identity && userScopeMatches(expected)) setFeedback({ identity, text: "下载没有完成，请再试一次" });
        } finally {
            // The browser starts reading the clicked link asynchronously.
            // Scope/unmount cleanup can revoke earlier; otherwise let it start first.
            if (url) { const savedURL = url; setTimeout(() => { URL.revokeObjectURL(savedURL); ownedURLs.current.delete(savedURL); }, 1000); }
        }
    }
    const statusText = (output: Extract<AssistantTurnOutput,{kind:"video"}>) => {
        const task = tasks[output.taskId];
        const ready = Boolean(assistantOutputResource(task));
        const unread = records.identity === identity && records.unread.includes(output.taskId);
        return unread ? "状态读取失败" : ready ? "可播放" : !task ? "读取中" : task.status === "failed" || task.status === "cancelled" ? "合成未完成" : task.status === "succeeded" ? "成片暂不可用" : task.status === "queued" || task.status === "running" ? "合成中" : "状态未确认";
    };
    const selectedOutput = selected?.identity === identity ? outputs.find(output => output.taskId === selected.taskId) : undefined;
    const primary = selectedOutput || [...outputs].reverse().find(output => assistantOutputResource(tasks[output.taskId])) || last;
    const primaryReady = primary && Boolean(assistantOutputResource(tasks[primary.taskId]));
    const version = (taskId: string) => `V${outputs.findIndex(output => output.taskId === taskId) + 1}`;
    const primaryTitle = primary ? `成片 ${version(primary.taskId)}` : "成片";
    const history = outputs.filter(output => output.taskId !== primary?.taskId).slice().reverse();
    const choosePlayback = (taskId: string) => { setSelected({ identity, taskId }); void play(taskId); };
    if (!outputs.length && !projects.length) return null;

    return <section className="canvas-assistant-delivery" aria-label="成片与工程">
        <header><strong>成片与工程</strong><span>{[outputs.length ? `${outputs.length} 个版本` : "", projects.length ? `${projects.length} 个工程` : ""].filter(Boolean).join(" · ")}</span></header>
        {primary ? <div aria-label="成片结果" className="canvas-assistant-delivery-main">
            <div className="canvas-assistant-delivery-video-row"><Film size={17} aria-hidden /><div className="canvas-assistant-delivery-file"><strong>{primaryTitle}</strong><small role="status">{statusText(primary)}</small></div>
                <div className="canvas-assistant-delivery-actions">
                    {primaryReady ? <><Tooltip title="播放成片"><Button type="text" size="small" aria-label={`播放${primaryTitle}`} loading={shownPlayback?.taskId === primary.taskId && shownPlayback.loading} icon={<Play size={14} />} onClick={() => choosePlayback(primary.taskId)}>播放</Button></Tooltip><Tooltip title="下载成片"><Button type="text" size="small" aria-label={`下载${primaryTitle}`} icon={<Download size={14} />} onClick={() => void download(primary.taskId, primaryTitle)} /></Tooltip></> : null}
                    {records.identity === identity && records.unread.includes(primary.taskId) ? <Tooltip title="重读状态"><Button type="text" size="small" aria-label="重读成片状态" icon={<RefreshCw size={14} />} onClick={() => setRetry(value => value + 1)} /></Tooltip> : null}
                </div>
            </div>
            {primaryReady && primary.taskId !== last?.taskId ? <p className="canvas-assistant-delivery-notice">{lastReady ? "正在查看之前的版本" : previousNotice}</p> : null}
            {shownPlayback?.taskId === primary.taskId && shownPlayback.url ? <div className="canvas-assistant-delivery-player"><Button type="text" size="small" aria-label="收起播放器" icon={<X size={13} />} onClick={() => { requestSerial.current++; setPlayback(null); if (playerURL.current) { URL.revokeObjectURL(playerURL.current); ownedURLs.current.delete(playerURL.current); playerURL.current = ""; } }}>收起</Button><Suspense fallback={<span>正在读取播放器…</span>}><Player src={shownPlayback.url} title={primaryTitle} mimeType="video/mp4" autoPlay compactControls className="w-full" /></Suspense></div> : null}
            {shownPlayback?.taskId === primary.taskId && shownPlayback.error ? <p className="canvas-assistant-delivery-notice" role="status">暂时无法播放，请重新读取成片。</p> : null}
        </div> : null}
        {projects.slice(-1).map(output => <AssistantProjectDownload key={output.resourceId} output={output} />)}
        {history.length || projects.length > 1 ? <details className="canvas-assistant-delivery-history"><summary><ChevronRight size={12} aria-hidden /><span>其他版本</span><small>{history.length + Math.max(0, projects.length - 1)}</small></summary>
            {history.length ? <div className="canvas-assistant-delivery-versions" data-canvas-wheel-scroll><table><caption className="sr-only">成片版本与状态</caption><thead><tr><th scope="col">版本</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
                {history.map(output => <tr key={output.taskId}><th scope="row">{version(output.taskId)}</th><td>{statusText(output)}</td><td><div className="canvas-assistant-delivery-actions">
                    {assistantOutputResource(tasks[output.taskId]) ? <><Tooltip title="播放此版本"><Button type="text" size="small" aria-label={`播放成片 ${version(output.taskId)}`} icon={<Play size={13} />} onClick={() => choosePlayback(output.taskId)} /></Tooltip><Tooltip title="下载此版本"><Button type="text" size="small" aria-label={`下载成片 ${version(output.taskId)}`} icon={<Download size={13} />} onClick={() => void download(output.taskId, `成片 ${version(output.taskId)}`)} /></Tooltip></> : records.identity === identity && records.unread.includes(output.taskId) ? <Tooltip title="重读状态"><Button type="text" size="small" aria-label={`重读成片 ${version(output.taskId)} 状态`} icon={<RefreshCw size={13} />} onClick={() => setRetry(value => value + 1)} /></Tooltip> : <span aria-label="无可用操作">—</span>}
                </div></td></tr>)}
            </tbody></table></div> : null}
            {projects.slice(0, -1).reverse().map(output => <AssistantProjectDownload key={output.resourceId} output={output} />)}
        </details> : null}
        {feedback?.identity === identity ? <p className="canvas-assistant-delivery-feedback" role="status">{feedback.text}</p> : null}
    </section>;
}
