/** Rasterize with the browser's installed fallback fonts; FFmpeg's virtual FS has no system fonts. */
export async function rasterizeTimelineSubtitle(text: string, width: number, height: number): Promise<Uint8Array> {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建字幕图像");
    const fontSize = Math.max(16, Math.round(height / 24));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const lines: string[] = [];
    for (const paragraph of text.split(/\r?\n/)) {
        let line = "";
        for (const char of paragraph) {
            if (line && ctx.measureText(line + char).width > width * 0.9) { lines.push(line); line = ""; }
            line += char;
        }
        lines.push(line);
    }
    if (lines.length * fontSize * 1.35 > height * 0.8) throw new Error("字幕过长，请拆分后导出");
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = Math.max(2, fontSize / 12);
    ctx.lineJoin = "round";
    lines.forEach((line, index) => {
        const y = height * 0.93 - (lines.length - index - 1) * fontSize * 1.35;
        ctx.strokeText(line, width / 2, y);
        ctx.fillText(line, width / 2, y);
    });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("字幕图像编码失败")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
}
