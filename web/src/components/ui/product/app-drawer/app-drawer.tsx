import { Drawer, type DrawerProps } from "antd";
import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

// 用途：产品侧栏壳。消费 token 由内容自己负责。默认 destroyOnHidden，可选 flush 去内边距。
export type AppDrawerProps = DrawerProps & {
    flush?: boolean;
};

export function AppDrawer({ flush = false, destroyOnHidden = true, styles, className, rootClassName, ...props }: AppDrawerProps) {
    const mergeResolvedStyles = (resolved: unknown) => {
        const base = resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
        if (!flush) return base;
        const body = base.body && typeof base.body === "object" ? (base.body as CSSProperties) : {};
        return { ...base, body: { ...body, padding: 0 } };
    };
    const mergedStyles =
        typeof styles === "function"
            ? (info: { props: DrawerProps }) => mergeResolvedStyles(styles(info))
            : mergeResolvedStyles(styles);

    return <Drawer destroyOnHidden={destroyOnHidden} className={className} rootClassName={rootClassName} {...props} styles={mergedStyles as DrawerProps["styles"]} />;
}

type DetailDrawerProps = {
    title: string;
    icon: ReactNode;
    open: boolean;
    onClose: () => void;
    busy?: boolean;
    rootClassName?: string;
    children: ReactNode;
    footer?: ReactNode;
};

export function DetailDrawer({ title, icon, open, onClose, busy = false, rootClassName = "", children, footer }: DetailDrawerProps) {
    return (
        <AppDrawer
            rootClassName={`workspace-detail-drawer ${rootClassName}`}
            open={open}
            onClose={() => { if (!busy) onClose(); }}
            aria-label={title}
            title={<div className="detail-drawer-title"><span className="detail-drawer-mark" aria-hidden>{icon}</span>{title}</div>}
            closable={{ placement: "end", disabled: busy }}
            closeIcon={<X size={18} aria-hidden />}
            mask={{ closable: !busy }}
            keyboard={!busy}
            size="min(420px, 100vw)"
            footer={footer}
        >
            {children}
        </AppDrawer>
    );
}
