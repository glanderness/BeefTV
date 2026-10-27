// 目录单价和费用估算的展示口径。价格只有两个来源：企业目录刷新时写进模型档案的
// pricing，以及后端 canvas.cost.estimate / canvas.generation.propose 返回的 estimate。
// 前端不自己算价，只把后端给的数字和原因翻译成用户看得懂的话。

export type ModelPricing = {
    currency: "CNY";
    kind: "image" | "video" | "audio";
    mode?: string;
    per_request_cny?: number;
    per_second_cny?: Record<string, number>;
    video_input_per_second_cny?: Record<string, number>;
    reference_image_cny?: number;
    free_reference_images?: number;
    input_cny?: number;
    output_cny?: number;
    video_official?: Array<{ resolution: string; input_per_second_cny?: number; output_per_second_cny: number }>;
    image_price_table?: {
        output?: Record<string, Record<string, number>>;
        reference?: number;
        default_quality?: string;
        default_size?: string;
        auto_quality?: string;
    };
};

/** 一项费用估算。amount 为 null 表示暂无价格，界面必须显示 basis 里的原因。 */
export type CostEstimateLine = {
    nodeId?: string;
    title?: string;
    kind: string;
    model?: string;
    amount: number | null;
    basis: string;
};

export type CostEstimate = {
    currency: string;
    total: number;
    known: boolean;
    unknownCount: number;
    items: CostEstimateLine[];
    text: string;
};

const PRICING_KINDS: ModelPricing["kind"][] = ["image", "video", "audio"];

const IMAGE_QUALITY_LABELS: Record<string, string> = {
    low: "低质量",
    medium: "中质量",
    high: "高质量",
    xhigh: "极高",
    max: "最高",
    standard: "标准",
    layers: "图层",
};

function priceNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function priceString(value: unknown): string | undefined {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
}

function priceRates(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const rates: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const rate = priceNumber(raw);
        const name = key.trim();
        if (name && rate !== undefined) rates[name] = rate;
    }
    return Object.keys(rates).length ? rates : undefined;
}

function priceOfficial(value: unknown): ModelPricing["video_official"] {
    if (!Array.isArray(value)) return undefined;
    const rates = value.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const row = raw as Record<string, unknown>;
        const resolution = priceString(row.resolution);
        const output = priceNumber(row.output_per_second_cny);
        if (!resolution || output === undefined) return [];
        const input = priceNumber(row.input_per_second_cny);
        // 目录没给参考视频单价时不补 0：有没有这个字段是两种不同的口径。
        return [{ resolution, ...(input === undefined ? {} : { input_per_second_cny: input }), output_per_second_cny: output }];
    });
    return rates.length ? rates : undefined;
}

function priceImageTable(value: unknown): ModelPricing["image_price_table"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const output: Record<string, Record<string, number>> = {};
    if (record.output && typeof record.output === "object" && !Array.isArray(record.output)) {
        for (const [quality, tiers] of Object.entries(record.output as Record<string, unknown>)) {
            const prices = priceRates(tiers);
            if (quality.trim() && prices) output[quality.trim()] = prices;
        }
    }
    const table: NonNullable<ModelPricing["image_price_table"]> = {};
    if (Object.keys(output).length) table.output = output;
    const reference = priceNumber(record.reference);
    if (reference !== undefined) table.reference = reference;
    for (const key of ["default_quality", "default_size", "auto_quality"] as const) {
        const text = priceString(record[key]);
        if (text) table[key] = text;
    }
    return Object.keys(table).length ? table : undefined;
}

/** 校验并收敛目录单价：只留下界面会显示、且形状正确的字段。 */
export function sanitizeModelPricing(value: unknown): ModelPricing | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const kind = priceString(record.kind);
    if (record.currency !== "CNY" || !PRICING_KINDS.includes(kind as ModelPricing["kind"])) return null;
    const pricing: ModelPricing = { currency: "CNY", kind: kind as ModelPricing["kind"] };
    const mode = priceString(record.mode);
    if (mode) pricing.mode = mode;
    const perRequest = priceNumber(record.per_request_cny);
    if (perRequest !== undefined) pricing.per_request_cny = perRequest;
    const perSecond = priceRates(record.per_second_cny);
    if (perSecond) pricing.per_second_cny = perSecond;
    const videoInput = priceRates(record.video_input_per_second_cny);
    if (videoInput) pricing.video_input_per_second_cny = videoInput;
    const referenceImage = priceNumber(record.reference_image_cny);
    if (referenceImage !== undefined) pricing.reference_image_cny = referenceImage;
    const freeReferences = priceNumber(record.free_reference_images);
    if (freeReferences !== undefined) pricing.free_reference_images = Math.floor(freeReferences);
    const input = priceNumber(record.input_cny);
    if (input !== undefined) pricing.input_cny = input;
    const output = priceNumber(record.output_cny);
    if (output !== undefined) pricing.output_cny = output;
    const official = priceOfficial(record.video_official);
    if (official) pricing.video_official = official;
    const table = priceImageTable(record.image_price_table);
    if (table) pricing.image_price_table = table;
    // 只剩 currency/kind 说明这一行没有任何可用价格。
    return Object.keys(pricing).length > 2 ? pricing : null;
}

/** 金额去掉多余的小数位：0.35000 → 0.35。 */
function money(value: number) {
    return String(Number(value.toFixed(4)));
}

function qualityLabel(quality: string) {
    return IMAGE_QUALITY_LABELS[quality.toLowerCase()] || quality;
}

/**
 * 一个模型的参考单价：模型选择器的价格弹层用它。没有目录单价时返回空数组，
 * 界面据此显示「价格暂不可用」，不能编一个数字出来。
 */
export function modelPriceLines(value: unknown): string[] {
    const pricing = sanitizeModelPricing(value);
    if (!pricing) return [];
    if (pricing.kind === "image") return imagePriceLines(pricing);
    if (pricing.kind === "video") return videoPriceLines(pricing);
    return audioPriceLines(pricing);
}

function imagePriceLines(pricing: ModelPricing): string[] {
    const lines: string[] = [];
    for (const [quality, tiers] of Object.entries(pricing.image_price_table?.output || {})) {
        const entries = Object.entries(tiers);
        if (!entries.length) continue;
        lines.push(`${qualityLabel(quality)}：${entries.map(([tier, price]) => `${tier} ¥${money(price)}`).join(" / ")}`);
    }
    if (!lines.length && pricing.per_request_cny !== undefined) lines.push(`每张 ¥${money(pricing.per_request_cny)}`);
    const reference = pricing.image_price_table?.reference;
    if (reference !== undefined) lines.push(`参考图 ¥${money(reference)} / 张`);
    return lines.length ? lines : ["图片价格暂不可用"];
}

function videoPriceLines(pricing: ModelPricing): string[] {
    const lines: string[] = [];
    for (const [resolution, rate] of Object.entries(pricing.per_second_cny || {})) lines.push(`${resolution}：¥${money(rate)} / 秒`);
    for (const row of pricing.video_official || []) lines.push(`${row.resolution}：约 ¥${money(row.output_per_second_cny)} / 秒（按 Token 折算）`);
    if (!lines.length && pricing.per_request_cny !== undefined) lines.push(`每次 ¥${money(pricing.per_request_cny)}`);
    if (pricing.reference_image_cny !== undefined) {
        const free = pricing.free_reference_images ?? 0;
        lines.push(free > 0
            ? `前 ${free} 张参考图免费，之后 ¥${money(pricing.reference_image_cny)} / 张`
            : `参考图 ¥${money(pricing.reference_image_cny)} / 张`);
    }
    return lines.length ? lines : ["按视频 Token 计费，具体以账单为准"];
}

function audioPriceLines(pricing: ModelPricing): string[] {
    const lines: string[] = [];
    if (pricing.per_request_cny !== undefined) lines.push(`¥${money(pricing.per_request_cny)} / 次`);
    if (pricing.input_cny !== undefined) lines.push(`约 ¥${money(pricing.input_cny)} / 百万字`);
    return lines.length ? lines : ["配音价格暂不可用"];
}

function estimateLine(value: unknown): CostEstimateLine | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const basis = typeof record.basis === "string" ? record.basis.trim() : "";
    if (!basis) return null;
    const amount = typeof record.amount === "number" && Number.isFinite(record.amount) && record.amount >= 0 ? record.amount : null;
    return {
        ...(priceString(record.nodeId) ? { nodeId: priceString(record.nodeId) } : {}),
        ...(priceString(record.title) ? { title: priceString(record.title) } : {}),
        kind: priceString(record.kind) || "",
        ...(priceString(record.model) ? { model: priceString(record.model) } : {}),
        amount,
        basis,
    };
}

/**
 * 校验后端费用估算。它是界面上的钱数，宁可显示「暂无价格」也不能显示读不懂的值：
 * 文本缺失或形状不对时返回 null，调用方回退到「按所选渠道实际标准计费」。
 */
export function sanitizeCostEstimate(value: unknown): CostEstimate | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text || !Array.isArray(record.items)) return null;
    const items = record.items.flatMap((item) => estimateLine(item) || []);
    if (items.length !== record.items.length) return null;
    return {
        currency: priceString(record.currency) || "CNY",
        total: priceNumber(record.total) ?? 0,
        known: record.known === true,
        unknownCount: priceNumber(record.unknownCount) ?? 0,
        items,
        text,
    };
}

/** 单项费用：金额算得出就带上依据，算不出就只说原因。 */
export function costLineText(line: CostEstimateLine): string {
    return line.amount === null ? line.basis : `预计费用 ¥${money(line.amount)}（${line.basis}）`;
}

/** 明细里的单项：金额在前、依据在后，和合计放在一起时不重复「预计费用」。 */
function costLineDetail(line: CostEstimateLine): string {
    return line.amount === null ? line.basis : `¥${money(line.amount)}（${line.basis}）`;
}

/** 明细最多列几组不同单价：批量确认框可能一次几百项，同价项合并计数。 */
const COST_DETAIL_LIMIT = 8;

/**
 * 确认框和卡片里的费用明细：先合计，再逐项列出金额与依据，同一依据合并计数。
 * 单项（含算不出的项）也要有自己的一行，不能只给一句通用提示。
 * 读不到估算时返回空数组，调用方回退到「按所选渠道实际标准计费」。
 */
export function costEstimateLines(estimate: CostEstimate | null | undefined): string[] {
    if (!estimate) return [];
    const groups = new Map<string, number>();
    for (const item of estimate.items) {
        const line = `${item.title ? `${item.title} · ` : ""}${costLineDetail(item)}`;
        groups.set(line, (groups.get(line) ?? 0) + 1);
    }
    const lines = [...groups.entries()].slice(0, COST_DETAIL_LIMIT).map(([line, count]) => count > 1 ? `${line} × ${count} 项` : line);
    if (groups.size > lines.length) lines.push(`…另有 ${groups.size - lines.length} 种单价项`);
    return [estimate.text, ...lines];
}

/**
 * 确认框里的一句话费用说明：合计在前、逐项明细在后。读不到估算时用调用方给的兜底
 * 说明，不编价格。批量确认框（批量表格、分镜）共用同一段文案。
 */
export function costConfirmText(estimate: CostEstimate | null | undefined, fallback: string): string {
    return costEstimateLines(estimate).join("；") || fallback;
}

/** 按节点找它这一项的费用；提议卡逐条列出目标和费用时用。 */
export function costLineForNode(estimate: CostEstimate | null | undefined, nodeId: string): CostEstimateLine | null {
    return estimate?.items.find((item) => item.nodeId === nodeId) || null;
}
