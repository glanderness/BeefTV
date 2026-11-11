import type { ReactNode } from "react";

import { Callout, type CalloutTone } from "@/components/ui/product/callout";

/** 工作区右下角的非阻塞提示，复用 Callout 的语义样式和主题 token。 */
export function WorkspaceNotice({ tone = "info", title, action, onClose }: { tone?: CalloutTone; title: string; action?: ReactNode; onClose: () => void }) {
    return (
        <div className="fixed bottom-5 right-5 z-[var(--z-toast)] w-[min(360px,calc(100vw-32px))]" role="status" aria-live="polite">
            <Callout
                tone={tone}
                title={title}
                action={action}
                onClose={onClose}
                closeLabel="关闭提示"
                className="shadow-[0_18px_50px_rgba(15,23,42,.22)] backdrop-blur-2xl"
            />
        </div>
    );
}
