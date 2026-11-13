import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildNodeGenerationInputs } from "../src/components/canvas/canvas-node-generation";
import {
    getEditableSelection,
    resolveEditableMentionRemoval,
    serializeEditableValue,
    setEditableSelection,
} from "../src/components/canvas/canvas-mention-editable-dom";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { IMAGE_PROMPT_REVERSE, VIDEO_PROMPT_REVERSE } from "../src/lib/prompts";
import { buildReversePromptNodePair } from "../src/pages/canvas/use-canvas-image-tools";
import { CanvasNodeType } from "../src/types/canvas";

class FakeNode {
    nodeType = 1;
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];
    textContent: string | null = "";

    get firstChild(): FakeNode | null {
        return this.childNodes[0] ?? null;
    }

    get lastChild(): FakeNode | null {
        return this.childNodes[this.childNodes.length - 1] ?? null;
    }

    appendChild<T extends FakeNode>(child: T): T {
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    contains(other: FakeNode | null): boolean {
        let current: FakeNode | null = other;
        while (current) {
            if (current === this) return true;
            current = current.parentNode;
        }
        return false;
    }
}

class FakeTextNode extends FakeNode {
    override nodeType = 3;
    constructor(text: string) {
        super();
        this.textContent = text;
    }
}

class FakeHTMLElement extends FakeNode {
    override nodeType = 1;
    readonly tagName: string;
    dataset: Record<string, string | undefined> = {};
    constructor(tagName: string) {
        super();
        this.tagName = tagName.toUpperCase();
    }
}

type FakeRange = {
    startContainer: FakeNode;
    startOffset: number;
    endContainer: FakeNode;
    endOffset: number;
    setStart: (node: FakeNode, offset: number) => void;
    collapse: (toStart?: boolean) => void;
};

const savedGlobals: Record<string, unknown> = {};
const globalNames = ["Node", "HTMLElement", "document", "window"] as const;
let currentRange: FakeRange | null = null;

beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const name of globalNames) savedGlobals[name] = g[name];
    currentRange = null;
    g.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    g.HTMLElement = FakeHTMLElement;
    g.document = {
        createRange(): FakeRange {
            const root = new FakeHTMLElement("div");
            const range: FakeRange = {
                startContainer: root,
                startOffset: 0,
                endContainer: root,
                endOffset: 0,
                setStart(node: FakeNode, offset: number) {
                    const max = node.nodeType === 3 ? (node.textContent?.length || 0) : node.childNodes.length;
                    if (offset < 0 || offset > max) {
                        throw new RangeError(`IndexSizeError: offset ${offset} out of [0, ${max}]`);
                    }
                    range.startContainer = node;
                    range.startOffset = offset;
                },
                collapse(toStart = false) {
                    if (toStart) {
                        range.endContainer = range.startContainer;
                        range.endOffset = range.startOffset;
                    }
                },
            };
            return range;
        },
    };
    g.window = {
        getSelection() {
            return {
                get rangeCount() {
                    return currentRange ? 1 : 0;
                },
                getRangeAt() {
                    return currentRange!;
                },
                removeAllRanges() {
                    currentRange = null;
                },
                addRange(range: FakeRange) {
                    currentRange = range;
                },
            };
        },
    };
});

afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const name of globalNames) g[name] = savedGlobals[name];
});

describe("reverse prompt node metadata", () => {
    test("stores instruction only in content so clearing content leaves no residual prompt", () => {
        const imageNode = createCanvasNode(CanvasNodeType.Image, { x: 100, y: 100 }, {
            content: "data:image/png;base64,AAAA",
            status: "success",
        });
        const { textNode, resultNode, connections } = buildReversePromptNodePair(imageNode, "gpt-4.1-mini");

        expect(textNode.metadata?.content).toBe(IMAGE_PROMPT_REVERSE);
        expect(textNode.metadata?.prompt).toBeUndefined();
        expect(textNode.metadata?.composerContent).toBeUndefined();
        expect(resultNode.metadata?.composerContent).toBe("参考图片：@图片1\n任务说明：@文本1");

        const initialInputs = buildNodeGenerationInputs(resultNode.id, [imageNode, textNode, resultNode], connections);
        expect(initialInputs.find((item) => item.type === "text")?.text).toBe(IMAGE_PROMPT_REVERSE);

        const clearedTextNode = { ...textNode, metadata: { ...textNode.metadata, content: "" } };
        const afterClearInputs = buildNodeGenerationInputs(resultNode.id, [imageNode, clearedTextNode, resultNode], connections);
        expect(afterClearInputs.find((item) => item.type === "text")).toBeUndefined();
    });

    test("builds video reverse prompt nodes without duplicate prompt metadata", () => {
        const videoNode = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, {
            content: "/api/resources/vid-1/file",
            storageKey: "resource:vid-1",
            status: "success",
        });
        const { textNode, resultNode } = buildReversePromptNodePair(videoNode);
        expect(textNode.title).toBe("视频反推提示词");
        expect(textNode.metadata?.content).toBe(VIDEO_PROMPT_REVERSE);
        expect(textNode.metadata?.prompt).toBeUndefined();
        expect(resultNode.metadata?.composerContent).toBe("参考视频：@视频1\n任务说明：@文本1");
    });
});

describe("editable mention DOM trailing sentinel <br> and Backspace cursor safety", () => {
    const refs: CanvasResourceReference[] = [
        { id: "r1", kind: "image", label: "图片1", title: "原图", nodeId: "img-1", active: true },
    ];

    test("ignores empty-editor placeholder <br> while preserving intermediate <br> line breaks", () => {
        const emptyRoot = new FakeHTMLElement("div");
        emptyRoot.appendChild(new FakeHTMLElement("br"));
        expect(serializeEditableValue(emptyRoot as unknown as HTMLElement)).toBe("");

        setEditableSelection(emptyRoot as unknown as HTMLElement, 0);
        expect(getEditableSelection(emptyRoot as unknown as HTMLElement)).toEqual({ start: 0, end: 0 });

        const twoLineRoot = new FakeHTMLElement("div");
        twoLineRoot.appendChild(new FakeTextNode("第一行"));
        twoLineRoot.appendChild(new FakeHTMLElement("br"));
        twoLineRoot.appendChild(new FakeTextNode("第二行"));
        expect(serializeEditableValue(twoLineRoot as unknown as HTMLElement)).toBe("第一行\n第二行");

        setEditableSelection(twoLineRoot as unknown as HTMLElement, 4);
        expect(getEditableSelection(twoLineRoot as unknown as HTMLElement)).toEqual({ start: 4, end: 4 });
        setEditableSelection(twoLineRoot as unknown as HTMLElement, 999);
        expect(getEditableSelection(twoLineRoot as unknown as HTMLElement)).toEqual({ start: 7, end: 7 });
    });

    test("does not duplicate newline or trap ghost newline when browser appends sentinel <br> after mention chip", () => {
        const root = new FakeHTMLElement("div");
        root.appendChild(new FakeTextNode("参考图片："));
        const chip = new FakeHTMLElement("span");
        chip.dataset.mentionToken = "@图片1";
        root.appendChild(chip);
        root.appendChild(new FakeTextNode("\n"));
        root.appendChild(new FakeHTMLElement("br"));

        expect(serializeEditableValue(root as unknown as HTMLElement)).toBe("参考图片：@图片1\n");
        setEditableSelection(root as unknown as HTMLElement, 10);
        expect(getEditableSelection(root as unknown as HTMLElement)).toEqual({ start: 10, end: 10 });

        // After browser deletes the "\n" text node and leaves sentinel <br> right after @图片1:
        const afterNewlineDeleted = new FakeHTMLElement("div");
        afterNewlineDeleted.appendChild(new FakeTextNode("参考图片："));
        const chip2 = new FakeHTMLElement("span");
        chip2.dataset.mentionToken = "@图片1";
        afterNewlineDeleted.appendChild(chip2);
        afterNewlineDeleted.appendChild(new FakeHTMLElement("br"));

        expect(serializeEditableValue(afterNewlineDeleted as unknown as HTMLElement)).toBe("参考图片：@图片1");
        setEditableSelection(afterNewlineDeleted as unknown as HTMLElement, 9);
        expect(resolveEditableMentionRemoval(afterNewlineDeleted as unknown as HTMLElement, refs, "Backspace")).toEqual({
            nextValue: "参考图片：",
            cursor: 5,
        });
    });
});
