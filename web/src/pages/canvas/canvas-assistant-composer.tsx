import { Button, Tooltip } from "antd";
import { Send, Square, X } from "lucide-react";
import { useState } from "react";

import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

const LINE_HEIGHT = 21;
const MIN_LINES = 1;
const MAX_LINES = 8;

type Props = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    streaming: boolean;
    disabled: boolean;
    disabledReason?: string;
    references: CanvasResourceReference[];
    selectedCount: number;
    selectionAttached: boolean;
    onDetachSelection: () => void;
    modelName?: string;
};

export function CanvasAssistantComposer({
    value,
    onChange,
    onSend,
    onStop,
    streaming,
    disabled,
    disabledReason,
    references,
    selectedCount,
    selectionAttached,
    onDetachSelection,
    modelName,
}: Props) {
    const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
    const height = Math.min(MAX_LINES * LINE_HEIGHT, Math.max(MIN_LINES * LINE_HEIGHT, contentHeight));
    const canSend = !disabled && Boolean(value.trim());

    return (
        <footer className="canvas-assistant-composer">
            <div className="canvas-assistant-chips">
                <span className="canvas-assistant-chip">当前画布</span>
                {selectionAttached && selectedCount > 0 ? (
                    <span className="canvas-assistant-chip">
                        已选 {selectedCount} 个节点
                        <button type="button" aria-label="这条消息不带已选节点" onClick={onDetachSelection}>
                            <X className="size-3" />
                        </button>
                    </span>
                ) : null}
            </div>

            <div className="canvas-assistant-input" style={{ height: height + 14 }}>
                <CanvasResourceMentionTextarea
                    value={value}
                    references={references}
                    onChange={onChange}
                    onSubmit={() => { if (canSend) onSend(); }}
                    includeAssetLibrary
                    containerClassName="h-full min-h-0"
                    className="thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-3 py-1.5 text-[var(--fs-caption)] leading-[21px] !shadow-none !outline-none !ring-0 focus:!shadow-none focus:!outline-none focus:!ring-0 placeholder:text-[var(--muted-foreground)]"
                    onContentSizeChange={setContentHeight}
                    disabled={disabled}
                    placeholder={disabled ? "" : "说说你想让画布变成什么样，用 @ 指定节点"}
                    aria-label="给助手的消息"
                />
            </div>

            {disabled && disabledReason ? <span className="canvas-assistant-meta">{disabledReason}</span> : null}

            <div className="canvas-assistant-composer-footer">
                <span className="canvas-assistant-model">{modelName || ""}</span>
                {streaming ? (
                    <Button size="small" icon={<Square className="size-3" />} onClick={onStop}>停止</Button>
                ) : (
                    <Tooltip title="Enter 发送 · Shift + Enter 换行" placement="topRight">
                        <Button size="small" type="primary" disabled={!canSend} icon={<Send className="size-3" />} onClick={onSend}>
                            发送
                        </Button>
                    </Tooltip>
                )}
            </div>
        </footer>
    );
}
