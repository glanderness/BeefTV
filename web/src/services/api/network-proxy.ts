import { http } from "./request";

export type NetworkProxyMode = "system" | "direct";
export type EffectiveNetworkProxyMode = "system" | "environment" | "direct";

export type NetworkProxyStatus = {
    mode: NetworkProxyMode;
    effectiveMode: EffectiveNetworkProxyMode;
    autoConfigOnly: boolean;
    assistantRestarted?: boolean;
    assistantRestartPending?: boolean;
};

export const NETWORK_PROXY_OPTIONS: Array<{ label: string; value: NetworkProxyMode }> = [
    { label: "跟随系统", value: "system" },
    { label: "不使用代理", value: "direct" },
];

let writeSeq = 0;
let statusVersion = 0;
let activeWrites = 0;

function normalizeNetworkProxyStatus(raw: unknown): NetworkProxyStatus {
    if (!raw || typeof raw !== "object") {
        throw new Error("网络代理状态格式无效");
    }
    const record = raw as Record<string, unknown>;
    const mode = record.mode === "direct" ? "direct" : record.mode === "system" ? "system" : null;
    if (!mode) {
        throw new Error("网络代理状态格式无效");
    }
    const effectiveMode: EffectiveNetworkProxyMode =
        record.effectiveMode === "system" || record.effectiveMode === "environment" || record.effectiveMode === "direct"
            ? record.effectiveMode
            : mode === "direct"
              ? "direct"
              : "system";
    return {
        mode,
        effectiveMode,
        autoConfigOnly: Boolean(record.autoConfigOnly),
        assistantRestarted: Boolean(record.assistantRestarted),
        assistantRestartPending: Boolean(record.assistantRestartPending),
    };
}

export async function getNetworkProxySettings(signal?: AbortSignal): Promise<{ status: NetworkProxyStatus; stale: boolean }> {
    const versionAtStart = statusVersion;
    const startedDuringWrite = activeWrites > 0;
    const raw = await http.get<NetworkProxyStatus>("/workspace/network-proxy", { signal });
    return {
        status: normalizeNetworkProxyStatus(raw),
        stale: startedDuringWrite || activeWrites > 0 || versionAtStart !== statusVersion,
    };
}

export async function updateNetworkProxyMode(mode: NetworkProxyMode): Promise<{ status: NetworkProxyStatus; stale: boolean }> {
    activeWrites += 1;
    const seq = ++writeSeq;
    statusVersion += 1;
    try {
        const raw = await http.put<NetworkProxyStatus>("/workspace/network-proxy", { mode });
        statusVersion += 1;
        return {
            status: normalizeNetworkProxyStatus(raw),
            stale: seq !== writeSeq,
        };
    } finally {
        activeWrites -= 1;
    }
}

export function networkProxyDescription(status: NetworkProxyStatus | null, loading: boolean, failed: boolean): string {
    if (!status) {
        if (failed) return "暂时无法读取网络代理设置，请稍后重试。";
        return loading ? "正在读取网络代理设置…" : "管理 BeefTV 与内置助手是否跟随系统代理。";
    }
    if (status.mode === "direct") {
        return "BeefTV 与内置助手均直连，不经过系统代理。若代理软件开启了 TUN 虚拟网卡，需在代理规则中放行 beeftv.app 或对应模型地址。";
    }
    if (status.autoConfigOnly) {
        return "系统当前使用自动代理脚本，BeefTV 暂按直连处理；如需明确关闭代理，可切为「不使用代理」。";
    }
    if (status.effectiveMode === "system") {
        return "当前已跟随系统代理。若开着代理导致助手无法回复，可切为「不使用代理」。";
    }
    if (status.effectiveMode === "environment") {
        return "当前跟随启动环境变量中的代理配置，如需直连可切为「不使用代理」。";
    }
    return "默认跟随系统代理，当前为直连。开启代理后若助手无法回复，可切为「不使用代理」。";
}

export function networkProxySavedNotice(mode: NetworkProxyMode, assistantRestartPending?: boolean): string {
    if (assistantRestartPending) {
        return mode === "direct" ? "已切为不使用代理，助手空闲后将自动生效" : "已切为跟随系统代理，助手空闲后将自动生效";
    }
    return mode === "direct" ? "已切为不使用代理（直连）" : "已切为跟随系统代理";
}
