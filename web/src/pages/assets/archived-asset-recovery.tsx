import { useState } from "react";
import { App, Button } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppModal } from "@/components/ui/product/app-modal";
import { assetLibraryQueryKey, assetPickerQueryKey, expectedScopeFromQueryKey, shouldSuppressAssetViewError } from "@/components/assets/asset-view-session";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { loadAssetLibraryPage } from "@/services/local-workspace-sync";
import { restoreWorkspaceArchivedAsset } from "@/services/workspace-asset-repository";

export function ArchivedAssetRecovery({ entryScope, ready }: { entryScope: CapturedUserScope; ready: boolean }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [restoring, setRestoring] = useState<string | null>(null);
    const count = useQuery({
        queryKey: assetLibraryQueryKey(entryScope, "archived-count"),
        queryFn: ({ queryKey, signal }) => loadAssetLibraryPage({ page: 1, pageSize: 1, status: "archived", signal, expectedScope: expectedScopeFromQueryKey(queryKey) }),
        enabled: ready,
    });
    const archived = useQuery({
        queryKey: assetLibraryQueryKey(entryScope, "archived-recovery", page),
        queryFn: ({ queryKey, signal }) => loadAssetLibraryPage({ page, pageSize: 20, status: "archived", signal, expectedScope: expectedScopeFromQueryKey(queryKey) }),
        enabled: ready && open,
    });
    const restore = async (id: string) => {
        if (restoring) return;
        setRestoring(id);
        try {
            await restoreWorkspaceArchivedAsset(id, entryScope);
            if (!userScopeMatches(entryScope)) return;
            message.success("素材已恢复到个人资产库");
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: assetLibraryQueryKey(entryScope) }),
                queryClient.invalidateQueries({ queryKey: assetPickerQueryKey(entryScope) }),
            ]);
        } catch (error) {
            if (!shouldSuppressAssetViewError(error, entryScope)) message.error(error instanceof Error ? error.message : "恢复失败，请重试");
        } finally {
            if (userScopeMatches(entryScope)) setRestoring(null);
        }
    };
    if (!open && !count.isError && !(count.data?.total || count.data?.canonicalTotal)) return null;
    return <>
        <Button onClick={() => { setPage(1); setOpen(true); }}>恢复已删除素材</Button>
        <AppModal title="恢复已删除素材" open={open} onCancel={() => { if (!restoring) setOpen(false); }} footer={null} closable={!restoring}>
            <p className="mb-4 text-sm text-foreground/65">这里保留了此前放入回收站的素材，可将需要的素材恢复到个人资产库。</p>
            {archived.isError ? <WorkspaceErrorState title="素材读取失败" description="请稍后重试。" actionLabel="重试" onRetry={() => void archived.refetch()} /> : !archived.isSuccess ? <WorkspaceLoadingState label="正在读取素材" /> : <>
                <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
                    {archived.data.assets.map((asset) => <li key={asset.id} className="flex min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate" title={asset.title}>{asset.title}</span>
                        <Button disabled={Boolean(restoring)} loading={restoring === asset.id} onClick={() => void restore(asset.id)}>恢复</Button>
                    </li>)}
                </ul>
                {!archived.data.assets.length ? <p>本页没有待恢复的素材。</p> : null}
                <div className="mt-4 flex items-center justify-end gap-3">
                    <Button disabled={page <= 1 || Boolean(restoring)} onClick={() => setPage((value) => value - 1)}>上一页</Button>
                    <span>第 {page} 页</span>
                    <Button disabled={!archived.data.canonicalHasMore || Boolean(restoring)} onClick={() => setPage((value) => value + 1)}>下一页</Button>
                </div>
            </>}
        </AppModal>
    </>;
}
