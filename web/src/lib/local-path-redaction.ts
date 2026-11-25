const UNIX_ROOT_DIRS =
    "Users|home|private|tmp|var|Volumes|mnt|media|run|root|opt|srv|etc|data|app|workspace|usr|proc|sys|dev|lib|bin|sbin";

// Single left-to-right alternation with explicit preceding-character checks
// instead of RegExp lookbehind (unsupported in Safari 15.4-16.3 WKWebView).
const LOCAL_PATH_SCAN = new RegExp(
    String.raw`(file:\/\/[^\r\n"'<>]+)|([a-z]:[\\/][^\r\n:"'<>]+)|(\\\\[^\r\n:"'<>]+)|(\/+(?:${UNIX_ROOT_DIRS})\/[^\r\n:"'<>]+)`,
    "gi",
);

const ASCII_LETTER = /[a-z]/i;
const UNIX_PATH_PREFIX_BLOCKED = /[A-Za-z0-9._-]/;
// Keep the app's own API route names visible only in explicit HTTP request logs
// (e.g. "GET /workspace/bootstrap"), while still redacting filesystem paths
// even if they happen to share the same path prefix.
const HTTP_METHOD_PREFIX = /(?:^|[\s"'(\[])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[ \t]+$/i;
const SAFE_APP_API_ROUTE = /^\/workspace\/(?:bootstrap|model-config(?:\/capability)?)(?:$|\s|[）),;\]])/i;

function isValidLocalPathMatch(match: RegExpExecArray, input: string): boolean {
    const offset = match.index;
    const prev = offset > 0 ? (input[offset - 1] ?? "") : "";
    if (match[2] !== undefined) {
        return offset === 0 || !ASCII_LETTER.test(prev);
    }
    if (match[4] !== undefined) {
        if (offset > 0 && UNIX_PATH_PREFIX_BLOCKED.test(prev)) return false;
        if (SAFE_APP_API_ROUTE.test(match[0]) && HTTP_METHOD_PREFIX.test(input.slice(0, offset))) {
            return false;
        }
    }
    return true;
}

export function hasLocalPath(text: string): boolean {
    if (!text) return false;
    LOCAL_PATH_SCAN.lastIndex = 0;
    let match = LOCAL_PATH_SCAN.exec(text);
    while (match) {
        if (isValidLocalPathMatch(match, text)) return true;
        LOCAL_PATH_SCAN.lastIndex = match.index + 1;
        match = LOCAL_PATH_SCAN.exec(text);
    }
    return false;
}

export function redactLocalPaths(text: string, replacement: string): string {
    if (!text) return text;
    LOCAL_PATH_SCAN.lastIndex = 0;
    let out = "";
    let cursor = 0;
    let match = LOCAL_PATH_SCAN.exec(text);
    while (match) {
        if (isValidLocalPathMatch(match, text)) {
            out += text.slice(cursor, match.index) + replacement;
            cursor = match.index + match[0].length;
        } else {
            LOCAL_PATH_SCAN.lastIndex = match.index + 1;
        }
        match = LOCAL_PATH_SCAN.exec(text);
    }
    return cursor === 0 ? text : out + text.slice(cursor);
}

// Pure diagnostic text sanitizer shared by client diagnostics and startup preflight
// (must stay free of React, store, or network imports).
export function redactDiagnosticText(value?: string, maxLength = 1200): string {
    let text = String(value || "").trim();
    if (!text) return "";
    if (/^[{[<]/.test(text)) return "[STRUCTURED_BODY_REDACTED]";
    text = text.replace(/["']?(authorization|cookie|set-cookie|api[_-]?key|secret[_-]?key|password|token|prompt|input|query)["']?\s*[:=：][\s\S]*/gi, "$1=[REDACTED]");
    text = text.replace(/\bBearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]+)*/gi, "[SECRET_REDACTED]");
    text = text.replace(/(?:https?:\/\/|blob:|data:)[^\s"'<>]+/gi, "[URL_REDACTED]");
    text = redactLocalPaths(text, "[PATH_REDACTED]");
    return text.slice(0, maxLength);
}
