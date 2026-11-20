function greatestCommonDivisor(a: number, b: number): number {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y !== 0) {
        const temp = y;
        y = x % y;
        x = temp;
    }
    return x || 1;
}

function inferAspectRatioText(width?: number, height?: number): string {
    if (!width || !height || width <= 0 || height <= 0) return "";
    const presets: Array<[string, number]> = [
        ["1:1", 1],
        ["16:9", 16 / 9],
        ["9:16", 9 / 16],
        ["4:3", 4 / 3],
        ["3:4", 3 / 4],
        ["3:2", 3 / 2],
        ["2:3", 2 / 3],
        ["4:5", 4 / 5],
        ["5:4", 5 / 4],
        ["21:9", 21 / 9],
        ["9:21", 9 / 21],
        ["2:1", 2],
    ];
    const actual = width / height;
    for (const [label, target] of presets) {
        if (Math.abs(actual - target) / target <= 0.03) return label;
    }
    const gcd = greatestCommonDivisor(width, height);
    const rw = Math.round(width / gcd);
    const rh = Math.round(height / gcd);
    return rw <= 32 && rh <= 32 ? `${rw}:${rh}` : `${actual.toFixed(2)}:1`;
}

export function formatImageRatio(size: string | undefined, width?: number, height?: number): string {
    const raw = size?.trim() || "";
    const inferred = inferAspectRatioText(width, height);
    if (!raw || raw.toLowerCase() === "auto") {
        return inferred ? (raw.toLowerCase() === "auto" ? `自适应（${inferred}）` : inferred) : raw ? "自适应" : "未记录";
    }
    const pixelMatch = raw.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (pixelMatch) {
        return inferAspectRatioText(Number(pixelMatch[1]), Number(pixelMatch[2])) || inferred || raw;
    }
    return raw;
}

export function formatMimeShort(mimeType?: string, url?: string): string {
    const mime = mimeType?.trim().toLowerCase() || "";
    if (mime.includes("png")) return "PNG";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "JPG";
    if (mime.includes("webp")) return "WEBP";
    if (mime.includes("gif")) return "GIF";
    const ext = url?.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]{3,4})$/i)?.[1];
    return ext ? ext.toUpperCase() : "";
}
