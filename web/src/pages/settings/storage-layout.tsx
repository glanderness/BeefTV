import type { ReactNode } from "react";

export function StorageRow({ name, value, action }: { name: string; value: ReactNode; action: ReactNode }) {
    return <div className="storage-row">
        <div className="storage-name">{name}</div>
        <div className="storage-value">{value}</div>
        <div className="storage-action">{action}</div>
    </div>;
}
