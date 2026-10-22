import { Check, Download, Slash, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Skill } from "@/services/api/skills";

type Props = {
    id: string;
    skills: Skill[];
    selectedIds: ReadonlySet<string>;
    activeIndex: number;
    loading: boolean;
    error: string;
    query: string;
    onSelect: (skill: Skill) => void;
    onHover: (index: number) => void;
    onRetry: () => void;
    onInstall: () => void;
};

export function CanvasAssistantSkillMenu({ id, skills, selectedIds, activeIndex, loading, error, query, onSelect, onHover, onRetry, onInstall }: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    return <div className="canvas-assistant-skill-menu" data-canvas-no-zoom data-canvas-wheel-scroll>
        <div className="canvas-assistant-skill-menu-heading"><span><Slash size={13} aria-hidden /> 技能</span><span>可组合使用</span></div>
        <div ref={listRef} id={id} role="listbox" aria-label="选择技能" aria-multiselectable="true" aria-busy={loading} className="canvas-assistant-skill-list">
            {loading ? <p role="status" className="canvas-assistant-skill-empty">正在读取技能…</p>
                : error ? <div className="canvas-assistant-skill-empty" role="status">{error}<button type="button" onClick={onRetry}>重新读取</button></div>
                    : skills.length ? skills.map((skill, index) => <button
                        key={skill.skillId} id={`${id}-${index}`} type="button" role="option" tabIndex={-1}
                        aria-selected={selectedIds.has(skill.skillId)} data-active={index === activeIndex}
                        className="canvas-assistant-skill-option"
                        onPointerDown={event => event.preventDefault()}
                        onMouseEnter={() => onHover(index)} onClick={() => onSelect(skill)}>
                        <span className="canvas-assistant-skill-icon"><Sparkles size={15} aria-hidden /></span>
                        <span className="canvas-assistant-skill-copy"><strong>{skill.skillName}</strong><span>{skill.description || "添加这项技能的创作方法"}</span></span>
                        {selectedIds.has(skill.skillId) ? <Check size={14} aria-label="已选择" /> : <span className="canvas-assistant-skill-enter" aria-hidden>↵</span>}
                    </button>) : <p role="status" className="canvas-assistant-skill-empty">{query ? "没有匹配的技能，试试其他关键词" : "还没有已安装的技能"}</p>}
        </div>
        <div className="canvas-assistant-skill-menu-footer"><span>↑↓ 选择 · Enter 添加 · Esc 关闭</span><button type="button" onClick={onInstall}><Download size={12} aria-hidden /> 安装技能</button></div>
    </div>;
}
