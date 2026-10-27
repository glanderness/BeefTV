import en from "./locales/en.json";

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
const dict: Record<string, string> = currentLocale === "en-US" ? (en as Record<string, string>) : {};

if (typeof document !== "undefined") document.documentElement.lang = currentLocale;

/** 构建期插件注入的翻译函数；key 为中文原文，模板变量为 {0}{1}… */
export function __t(key: string, args?: unknown[]): string {
    const template = dict[key] || key;
    if (!args) return template;
    return template.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)]) : match));
}

export function setLocale(next: Locale) {
    try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
        return;
    }
    window.location.reload();
}
