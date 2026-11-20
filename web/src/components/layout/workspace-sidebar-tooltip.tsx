import { Tooltip } from "antd";
import type { ReactElement, ReactNode } from "react";

export function WorkspaceSidebarTooltip({ children, title }: { children: ReactElement; title: ReactNode }) {
    return (
        <Tooltip
            title={title}
            placement="top"
            trigger={["hover", "focus"]}
            mouseEnterDelay={0.15}
            mouseLeaveDelay={0.1}
            rootClassName="app-workspace-sidebar-tooltip"
            classNames={{ container: "app-workspace-sidebar-tooltip-content" }}
        >
            {children}
        </Tooltip>
    );
}
