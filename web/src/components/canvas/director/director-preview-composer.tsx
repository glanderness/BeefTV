import { Input } from "antd";

/**
 * 预演画布上的镜头意图输入。
 * 只编辑已有 shot.prompt；不展示尚未接入的自然语言场景生成操作。
 */
export function DirectorPreviewComposer({ prompt, onPromptChange }: { prompt: string; onPromptChange: (prompt: string) => void }) {
    return (
        <div className="director-preview-composer" role="group" aria-label="镜头意图">
            <Input.TextArea aria-label="当前镜头意图" data-canvas-no-zoom autoSize={{ minRows: 1, maxRows: 3 }} value={prompt} placeholder="选中一个元素或机位，描述当前镜头的动作与叙事意图…" onChange={(event) => onPromptChange(event.target.value)} />
        </div>
    );
}
