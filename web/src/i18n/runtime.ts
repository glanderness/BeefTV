import en from "./locales/en.json";
import enBackend from "./locales/en.backend.json";

export type Locale = "zh-CN" | "en-US";
export const LOCALE_STORAGE_KEY = "beeftv.locale";

function readLocale(): Locale {
    try {
        return localStorage.getItem(LOCALE_STORAGE_KEY) === "en-US" ? "en-US" : "zh-CN";
    } catch {
        return "zh-CN";
    }
}

export const currentLocale: Locale = typeof window === "undefined" ? "zh-CN" : readLocale();
// 后端词条只在显示时（__tv）用于翻译接口返回的报错；前端词条同名时优先
const dict: Record<string, string> = currentLocale === "en-US" ? { ...(enBackend as Record<string, string>), ...(en as Record<string, string>) } : {};

if (typeof document !== "undefined") document.documentElement.lang = currentLocale;

const fill = (template: string, args: readonly unknown[]) => template.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)]) : match));

/** 构建期插件注入的翻译函数；key 为中文原文，模板变量为 {0}{1}… */
export function __t(key: string, args?: unknown[]): string {
    const template = dict[key] || key;
    return args ? fill(template, args) : template;
}

const CJK = /[一-鿿]/;

// 带 {0} 的词条编成正则，用来认出已经拼好变量的整句（如后端报错、计数文案）
let patterns: { re: RegExp; to: string }[] | undefined;
function compilePatterns() {
    const list: { re: RegExp; to: string; literal: number }[] = [];
    for (const [key, to] of Object.entries(dict)) {
        const literal = key.replace(/\{\d+\}/g, "");
        if (!to || !key.includes("{0}") || !CJK.test(literal)) continue;
        const order: number[] = [];
        const body = key
            .split(/(\{\d+\})/)
            .map((part) => {
                const slot = /^\{(\d+)\}$/.exec(part);
                if (!slot) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                order.push(Number(slot[1]));
                return "(.+?)";
            })
            .join("");
        list.push({ re: new RegExp(`^${body}$`, "s"), to: to.replace(/\{(\d+)\}/g, (match, index) => (order.includes(Number(index)) ? `{${order.indexOf(Number(index))}}` : match)), literal: literal.length });
    }
    // 字面部分越长越具体，优先匹配
    patterns = list.sort((a, b) => b.literal - a.literal);
}

function lookup(text: string): string | undefined {
    const trimmed = text.trim();
    const wrap = (translated: string) => (trimmed === text ? translated : text.replace(trimmed, () => translated));
    const exact = dict[trimmed];
    if (exact) return wrap(exact);
    if (!patterns) compilePatterns();
    for (const { re, to } of patterns!) {
        const match = re.exec(trimmed);
        // 变量部分可能本身也是词条（后端 %w 包裹的下层报错），递归查一次
        if (match) return wrap(fill(to, match.slice(1).map((arg) => (CJK.test(arg) ? lookup(arg) ?? arg : arg))));
    }
    return undefined;
}

// 提示类文案常由多段拼成（"保存失败：项目不存在"），整句查不到时按标点拆开逐段翻译
const SEGMENT = /([：:；;。，,！!？?\n]\s*)/;
const translateSegments = (text: string) => text.split(SEGMENT).map((part) => (CJK.test(part) ? lookup(part) ?? part : part)).join("");

const exactCache = new Map<string, string>();
const looseCache = new Map<string, string>();

/** 阶段 4：显示前再查一次词典。值不是中文或查不到时原样返回；loose 允许按分句翻译 */
export function __tv<T>(value: T, loose?: 1): T {
    if (currentLocale !== "en-US" || typeof value !== "string" || !CJK.test(value)) return value;
    const cache = loose ? looseCache : exactCache;
    let out = cache.get(value);
    if (out === undefined) {
        out = lookup(value) ?? (loose ? translateSegments(value) : value);
        if (cache.size > 5000) cache.clear();
        cache.set(value, out);
    }
    return out as T;
}

export function setLocale(next: Locale) {
    try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
        return;
    }
    window.location.reload();
}
