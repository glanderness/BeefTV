import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { getCanvasHydrationHealth, subscribeCanvasHydrationHealth } from "@/services/canvas-hydration-health";
import { useNavigate, useSearchParams } from "react-router";
import { Alert, App, Button, Dropdown, Input, Modal } from "antd";
import { Download, FolderPlus, MoreHorizontal, Plus, Trash2, Upload } from "lucide-react";

import { CollectionGrid, PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { ExpandableSearch } from "@/components/layout/expandable-search";
import { WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";

import { CanvasFolderCard } from "@/components/canvas/canvas-folder-card";
import { CanvasDeleteConfirmation } from "@/components/canvas/canvas-delete-confirmation";
import { RecycleBinDialog } from "@/components/canvas/recycle-bin-dialog";
import { LibraryCardShell } from "@/components/canvas/library-card-shell";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { canvasExportProgressLabel, exportCanvasProjectsByIds, type CanvasExportProgress } from "@/lib/canvas/canvas-export";
import { downloadCanvasProjectsMediaByIds } from "@/lib/canvas/canvas-batch-download";
import { restoreCanvasArchive } from "@/lib/canvas/canvas-archive-restore";
import { readCanvasLibraryCover } from "@/lib/canvas/canvas-library-cover";
import { createCanvasLibraryFolder, deleteCanvasLibraryFolder, hydrateCanvasLibraryFolders, persistCanvasFolderCover, renameCanvasLibraryFolder } from "@/lib/canvas/canvas-folder-storage";
import { isWailsNativeShell } from "@/services/desktop-media-save";
import { loadCanvasProjectForEditing } from "@/services/local-workspace-sync";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { beginLocalCanvasProject, deleteLocalCanvasProjects, hydrateLocalCanvasProjectsFromBackend, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { duplicateWorkspaceCanvasProject } from "@/services/workspace-project-repository";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { loadCanvasProjectPage } from "@/lib/workspace-route-modules";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { cn } from "@/lib/utils";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { canvasIdsForWorkspaceProjects, canvasWorkspaceProjectId, listCanvasWorkspaceProjectRoots, previewNodesForWorkspaceProject, resolveWorkspaceExportCanvasIds } from "@/lib/canvas/canvas-workspace-project";

const CanvasDeleteProjectsDialog = lazy(() => import("@/components/canvas/canvas-delete-projects-dialog").then((module) => ({ default: module.CanvasDeleteProjectsDialog })));

export function canAutoOpenCanvasEntry(input: {
    hydrated: boolean;
    alreadyOpened: boolean;
    mode: string | null;
    canvasHealth: { loading: boolean; error: string };
}) {
    if (!input.hydrated || input.alreadyOpened) return false;
    if (input.mode !== "new" && input.mode !== "recent" && input.mode !== "handoff") return false;
    // A new local canvas can be created while older projects are still
    // hydrating. Waiting for every historical canvas leaves this route on
    // the loading screen when one large project or cache write is slow.
    if (input.mode !== "new" && (input.canvasHealth.loading || input.canvasHealth.error)) return false;
    return true;
}

export default function CanvasPage() {
    const canvasHealth = useSyncExternalStore(subscribeCanvasHydrationHealth, getCanvasHydrationHealth);
    const { message } = App.useApp();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [keyword, setKeyword] = useState("");
    const [folderFilter, setFolderFilter] = useState("all");
    const [folderDialogOpen, setFolderDialogOpen] = useState(false);
    const [folderName, setFolderName] = useState("");
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string } | null>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const [loadedProjectCount, setLoadedProjectCount] = useState(50);
    const [creationError, setCreationError] = useState(false);
    const [coverError, setCoverError] = useState("");
    const exportController = useRef<AbortController | null>(null);
    const [exportProgress, setExportProgress] = useState<CanvasExportProgress | null>(null);
    const [exportError, setExportError] = useState("");
    useEffect(() => () => exportController.current?.abort(), []);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const moveProjectsToFolder = useCanvasStore((state) => state.moveProjectsToFolder);
    useEffect(() => {
        if (!hydrated) return;
        void hydrateLocalCanvasProjectsFromBackend();
        void hydrateCanvasLibraryFolders().catch((error) => {
            message.error(error instanceof Error ? error.message : "文件夹列表读取失败");
        });
    }, [hydrated, message]);
    const projects = useMemo<CanvasLibrarySummary[]>(() => (
        listCanvasWorkspaceProjectRoots(localProjects).map((project) => ({
            ...project,
            nodeCount: project.summaryNodeCount ?? project.nodes.length,
            previewNodes: previewNodesForWorkspaceProject(localProjects, canvasWorkspaceProjectId(project)),
        }))
    ), [localProjects]);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const deleteDialogOpen = useCanvasUiStore((state) => state.deleteProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const selectedCanvasIds = canvasIdsForWorkspaceProjects(localProjects, selectedIds);
    const deleteSelectedProjects = () => {
        setDeleteIds(selectedCanvasIds);
    };
    const [historyOpen, setHistoryOpen] = useState(() => searchParams.get("history") === "all" || searchParams.get("history") === "deleted");

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const handoffMode = mode === "handoff";
    const forwardedQuery = agentMode || handoffMode || searchParams.get("agent") === "1" ? `?${searchParams.toString()}` : "";
    const preloadProject = useCallback(() => {
        void loadCanvasProjectPage();
    }, []);
    const enterProject = useCallback(
        (id: string) => {
            preloadProject();
            navigate(`/canvas/${id}${forwardedQuery}`);
        },
        [forwardedQuery, navigate, preloadProject],
    );
    const createAndEnter = () => {
        setCreationError(false);
        const { id, saved } = beginLocalCanvasProject("未命名项目");
        void saved.then(() => {
            // Only enter after the desktop repository has accepted the new canvas.
            if (searchParams.get("stay") !== "1") enterProject(id);
        }).catch((error) => {
            setCreationError(true);
            message.error(error instanceof Error ? error.message : "创建项目失败，请重试");
        });
    };
    const duplicateCanvasProject = useCallback(async (project: CanvasLibrarySummary) => {
        try {
            const { workspaceProjectId, count } = await duplicateWorkspaceCanvasProject(localProjects, project);
            message.success(`项目副本已创建，共 ${count} 张画布`);
            enterProject(workspaceProjectId);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "复制项目失败，请重试");
        }
    }, [enterProject, localProjects, message]);
    const filteredProjects = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        // The root library represents uncategorized work alongside folder tiles.
        // Categorized projects must disappear from the root after being moved and
        // only reappear when their folder is opened.
        const scoped = projects.filter((project) => (folderFilter === "all" ? !project.folderId : project.folderId === folderFilter));
        const values = query ? scoped.filter((project) => project.title.toLowerCase().includes(query)) : [...scoped];
        values.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return values;
    }, [folderFilter, keyword, projects]);
    const visibleProjects = filteredProjects.slice(0, loadedProjectCount);
    const hasMore = visibleProjects.length < filteredProjects.length;
    // Folder tiles belong to the root library only. Once a folder is opened,
    // the grid represents that folder's contents; rendering the active folder
    // tile again makes an empty folder look like it contains itself.
    const visibleFolders = folderFilter === "all" ? folders : [];
    const activeFolder = folderFilter === "all" ? undefined : folders.find((folder) => folder.id === folderFilter);
    const saveFolderRename = () => {
        const nextName = folderName.trim() || "未命名文件夹";
        const id = editingFolderId;
        setFolderName("");
        setEditingFolderId(null);
        setFolderDialogOpen(false);
        if (!id) return;
        void renameCanvasLibraryFolder(id, nextName).catch((error) => {
            message.error(error instanceof Error ? error.message : "文件夹没有保存成功");
        });
    };
    useEffect(() => {
        setLoadedProjectCount(50);
    }, [folderFilter, keyword]);
    useEffect(() => {
        const node = loadMoreRef.current;
        if (!node || !hasMore) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;
                setLoadedProjectCount((count) => Math.min(count + 50, filteredProjects.length));
            },
            { rootMargin: "600px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [filteredProjects.length, visibleProjects.length, hasMore]);
    const exportCanvasByIds = async (canvasIds: readonly string[], archiveTitle?: string) => {
        if (exportController.current || !canvasIds.length) return;
        const controller = new AbortController();
        exportController.current = controller;
        setExportError("");
        setExportProgress({ phase: "loading" });
        try {
            let skippedCount = 0;
            const saved = await exportCanvasProjectsByIds(
                canvasIds,
                (id) => loadCanvasProjectForEditing(id),
                {
                    archiveTitle: archiveTitle || `${brandName}画布-${canvasIds.length}个画布`,
                    folders,
                    allowMissingMedia: true,
                    signal: controller.signal,
                    onProgress: setExportProgress,
                    onSkipped: (count) => { skippedCount = count; },
                },
            );
            if (saved !== "cancelled") {
                if (skippedCount > 0) message.warning(`已导出备份，已自动跳过 ${skippedCount} 个缺失或无法读取的素材`);
                else if (saved === "saved" && isWailsNativeShell()) message.success("已保存到所选位置");
            }
        } catch (error) {
            if (controller.signal.aborted) {
                recordDiagnosticEvent({ category: "action", level: "info", code: "canvas_export_cancelled", message: "已取消画布导出" });
            } else {
                setExportError(error instanceof Error ? error.message : "导出失败，请重试");
                recordDiagnosticEvent({ category: "action", level: "error", code: "canvas_export_failed", message: "画布导出失败" });
            }
        } finally {
            exportController.current = null;
            setExportProgress(null);
        }
    };
    const exportSelected = () => exportCanvasByIds(resolveWorkspaceExportCanvasIds(localProjects, selectedIds));
    const exportWorkspaceProject = (project: CanvasLibrarySummary) => {
        const ids = resolveWorkspaceExportCanvasIds(localProjects, [project.id]);
        return exportCanvasByIds(ids, `${project.title || brandName}-${ids.length}个画布`);
    };
    const downloadWorkspaceProjectMedia = (project: CanvasLibrarySummary) => {
        const ids = resolveWorkspaceExportCanvasIds(localProjects, [project.id]);
        return downloadCanvasProjectsMediaByIds(
            ids,
            async (id) => {
                const cached = useCanvasStore.getState().openProject(id);
                return cached && !cached.summaryOnly ? cached : loadCanvasProjectForEditing(id);
            },
            message,
        );
    };
    const exportFolderProjects = (folder: { id: string; name: string }) => {
        const folderProjectIds = projects.filter((project) => project.folderId === folder.id).map((project) => project.id);
        const ids = resolveWorkspaceExportCanvasIds(localProjects, folderProjectIds);
        if (!ids.length) {
            message.info("当前文件夹暂无可导出的项目");
            return Promise.resolve();
        }
        return exportCanvasByIds(ids, `${folder.name}-${ids.length}个画布`);
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        const hideLoading = message.loading({ content: "正在解压并准备导入画布...", duration: 0 });
        try {
            const result = await restoreCanvasArchive(file, {
                onProjectProgress: (projectId, progress) => {
                    useSyncProgressStore.getState().setProjectProgress(projectId, progress);
                },
            });
            hideLoading();
            if (result.skippedFiles?.length) {
                message.warning(`已导入 ${result.count} 个画布，跳过 ${result.skippedFiles.length} 项缺失内容`);
            } else {
                message.success(result.storage === "backend"
                    ? `已导入 ${result.count} 个画布`
                    : `已导入 ${result.count} 个画布并保存到本地`);
            }
        } catch (error) {
            hideLoading();
            console.error("导入画布失败", error);
            message.error(error instanceof Error ? `导入失败：${error.message}` : "导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!canAutoOpenCanvasEntry({ hydrated, alreadyOpened: autoOpenRef.current, mode, canvasHealth })) return;
        autoOpenRef.current = true;
        if (mode === "recent" && projects[0]?.id) {
            enterProject(projects[0].id);
            return;
        }
        const { id, saved } = beginLocalCanvasProject("未命名项目");
        void saved.then(() => enterProject(id)).catch((error) => {
            setCreationError(true);
            message.error(error instanceof Error ? error.message : "创建项目失败，请重试");
        });
    }, [hydrated, message, mode, projects, canvasHealth]);

    if (!creationError && !canvasHealth.error && (mode === "new" || mode === "recent" || mode === "handoff")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在打开画布...</main>;

    return (
        <WorkspacePage className="studio-collection-page lib-tv-project-page">
            <PageHeader
                title={activeFolder?.name || "全部项目"}
                leading={activeFolder ? <button type="button" className="libtv-project-breadcrumb-button" onClick={() => setFolderFilter("all")}>全部项目 /</button> : undefined}
                actions={(
                    <div className="libtv-project-actions">
                    <ExpandableSearch value={keyword} placeholder="搜索项目" onChange={setKeyword} />
                    <Button icon={<Upload />} disabled={!hydrated} onClick={() => inputRef.current?.click()}>导入画布</Button>
                    <Button icon={<Trash2 />} onClick={() => setHistoryOpen(true)}>回收站</Button>
                    <Button icon={<FolderPlus />} disabled={!hydrated} onClick={() => {
                        void createCanvasLibraryFolder("未命名文件夹").catch((error) => {
                            message.error(error instanceof Error ? error.message : "文件夹没有保存成功");
                        });
                    }}>新建文件夹</Button>
                    </div>
                )}
            />

            <div className="collection-content">
                {selectedIds.length || exportProgress ? (
                    <div className="collection-selection-bar">
                        <strong className="mr-auto font-medium">{exportProgress ? "正在导出画布" : `已选 ${selectedIds.length} 个项目`}</strong>
                        <Button size="small" aria-label="导出" disabled={!hydrated} loading={Boolean(exportProgress)} icon={<Download className="size-3.5" />} onClick={() => void exportSelected()}>
                            导出
                        </Button>
                        {exportProgress ? <>
                            <span className="text-sm text-foreground/65" role="status" aria-live="polite">{canvasExportProgressLabel(exportProgress)}</span>
                            <Button size="small" disabled={exportProgress.phase === "saving"} onClick={() => exportController.current?.abort()}>取消导出</Button>
                        </> : null}
                        <Button size="small" danger disabled={!hydrated || Boolean(exportProgress)} onClick={deleteSelectedProjects}>
                            删除
                        </Button>
                    </div>
                ) : null}

                {exportError ? <p role="alert" className="mb-4 whitespace-pre-wrap break-words text-sm text-destructive">{exportError}</p> : null}
                {coverError ? (
                    <div className="sticky top-2 z-10 mb-4">
                        <Alert type="error" title={coverError} showIcon closable={{ closeIcon: true, onClose: () => setCoverError("") }} />
                    </div>
                ) : null}

                {canvasHealth.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm"><span>{canvasHealth.error}</span><Button loading={canvasHealth.loading} onClick={() => void hydrateLocalCanvasProjectsFromBackend()}>重试加载</Button></div> : null}
                {!hydrated ? (
                    <WorkspaceLoadingState label="正在恢复画布" detail="读取本地工作区画布" />
                ) : visibleProjects.length || !keyword ? (
                    <CollectionGrid className="canvas-collection-grid">
                        <div className="libtv-create-project-entry">
                            <article className="libtv-create-project-card" role="button" tabIndex={0} onClick={createAndEnter} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); createAndEnter(); } }}>
                                <div className="libtv-create-project-icon"><Plus /></div>
                                <strong>开始创作</strong>
                            </article>
                            <p className="libtv-create-project-subtitle">创建新的视频项目</p>
                        </div>
                        {visibleFolders.map((folder) => <CanvasLibraryFolderTile key={folder.id} folder={folder} onOpen={() => setFolderFilter(folder.id)} onRename={() => { setFolderName(folder.name); setEditingFolderId(folder.id); setFolderDialogOpen(true); } } onExport={() => void exportFolderProjects(folder)} onDelete={() => setDeletingFolder({ id: folder.id, name: folder.name })}
                            onCoverError={(error) => setCoverError(error && `「${folder.name}」：${error}`)} onCoverChange={(dataUrl) => {
                            void persistCanvasFolderCover(folder.id, dataUrl).then(() => {
                                message.success("文件夹封面已更新");
                            }).catch((error) => {
                                message.error(error instanceof Error ? error.message : "封面没有保存成功");
                            });
                        }} />)}
                        {visibleProjects.map((project) => (
                            <CanvasFolderCard
                                key={project.id}
                                project={project}
                                onCoverError={(error) => setCoverError(error && `「${project.title}」：${error}`)}
                                folders={folders}
                                onMoveToFolder={async (folderId) => {
                                    try {
                                        // Keep the menu action transactional: validate the selected
                                        // folder, update the local store, then verify the in-memory
                                        // relation before reporting success. This prevents a stale
                                        // menu/list state from making a failed move look successful.
                                        if (folderId && !folders.some((folder) => folder.id === folderId)) {
                                            throw new Error("目标文件夹不存在");
                                        }
                                        const projectCanvasIds = canvasIdsForWorkspaceProjects(localProjects, [project.id]);
                                        for (const canvasId of projectCanvasIds) {
                                            if (useCanvasStore.getState().openProject(canvasId)?.summaryOnly) {
                                                const loaded = await loadCanvasProjectForEditing(canvasId);
                                                if (!loaded) throw new Error("画布已不存在，无法移动");
                                            }
                                        }
                                        moveProjectsToFolder(projectCanvasIds, folderId);
                                        await flushCanvasStorePersistence();
                                        const movedProject = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                                        if (!movedProject || (movedProject.folderId || undefined) !== (folderId || undefined)) {
                                            throw new Error("项目移动未完成，请重试");
                                        }
                                        if (!usesBrowserLocalResourceStore()) {
                                            await Promise.all(projectCanvasIds.map((id) => syncLocalCanvasProjectToBackend(id)));
                                        }
                                        message.success(folderId ? "已移动到文件夹" : "已移出文件夹");
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "移动项目失败");
                                    }
                                }}
                                onDuplicate={() => duplicateCanvasProject(project)}
                                onDownloadMedia={() => { void downloadWorkspaceProjectMedia(project); }}
                                onExport={() => exportWorkspaceProject(project)}
                                onDelete={() => {
                                    setDeleteIds([project.id]);
                                }}
                                onClick={() => enterProject(project.id)}
                                onPrefetch={preloadProject}
                            />
                        ))}
                    </CollectionGrid>
                ) : (
                    <WorkspaceState icon="canvas" title={canvasHealth.error ? "项目暂时无法加载" : keyword || folderFilter !== "all" ? "没有匹配的项目" : "让第一个想法落在画布上"} description={canvasHealth.error || (keyword || folderFilter !== "all" ? "换一个名称或重置筛选条件。" : "图片、分镜和灵感，都可以在这里自由组织。")} action={canvasHealth.error ? <Button loading={canvasHealth.loading} onClick={() => void hydrateLocalCanvasProjectsFromBackend()}>重试加载</Button> : !keyword && folderFilter === "all" ? <Button type="primary" icon={<Plus />} disabled={!hydrated} onClick={createAndEnter}>新建项目</Button> : undefined} />
                )}
                {hydrated && visibleProjects.length && hasMore ? (
                    <div ref={loadMoreRef} className="library-load-more" aria-live="polite">
                        继续下滑加载更多
                    </div>
                ) : null}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <Modal
                className="libtv-folder-dialog"
                wrapClassName="libtv-folder-dialog-wrap"
                title="重命名文件夹"
                open={folderDialogOpen}
                okText="保存"
                okButtonProps={{ type: "default" }}
                cancelText="取消"
                onCancel={() => { setFolderDialogOpen(false); setEditingFolderId(null); setFolderName(""); }}
                onOk={saveFolderRename}
            >
                <Input autoFocus value={folderName} placeholder="例如：短片项目" onChange={(event) => setFolderName(event.target.value)} onPressEnter={saveFolderRename} />
            </Modal>
            <RecycleBinDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
            {deletingFolder ? <CanvasDeleteConfirmation title={`删除文件夹「${deletingFolder.name}」？`}
                description={`将删除此文件夹及其中 ${localProjects.filter((project) => project.folderId === deletingFolder.id).length} 个画布，画布里的节点和连线也会一起移除。`}
                onCancel={() => setDeletingFolder(null)} onConfirm={async () => {
                    const folderId = deletingFolder.id;
                    const ids = useCanvasStore.getState().projects.filter((project) => project.folderId === folderId).map((project) => project.id);
                    if (ids.length) await deleteLocalCanvasProjects(ids);
                    await deleteCanvasLibraryFolder(folderId);
                    message.success(ids.length ? `已删除文件夹及其中 ${ids.length} 个画布` : "文件夹已删除");
                }} /> : null}
            {deleteDialogOpen ? <Suspense fallback={null}><CanvasDeleteProjectsDialog /></Suspense> : null}
        </WorkspacePage>
    );
}

function CanvasLibraryFolderTile({ folder, onOpen, onRename, onExport, onDelete, onCoverChange, onCoverError }: { folder: { id: string; name: string; updatedAt: string; coverDataUrl?: string }; onOpen: () => void; onRename: () => void; onExport: () => void; onDelete: () => void; onCoverChange: (dataUrl: string) => void; onCoverError: (error: string) => void }) {
    const coverInputRef = useRef<HTMLInputElement>(null);
    const chooseCover = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        onCoverError("");
        try {
            onCoverChange(await readCanvasLibraryCover(file));
        } catch (error) {
            onCoverError(error instanceof Error ? error.message : "封面图片读取失败");
        }
    };
    return (
        <LibraryCardShell
            ariaLabel={`打开文件夹 ${folder.name}`}
            className="libtv-folder-card"
            updatedAt={folder.updatedAt}
            onOpen={onOpen}
            title={folder.name}
            cover={<div className={cn("libtv-folder-cover-art", folder.coverDataUrl && "has-custom-cover")} style={folder.coverDataUrl ? { backgroundImage: `url(${folder.coverDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined} />}
            actions={<>
                <Dropdown
                trigger={["click"]}
                placement="bottomRight"
                overlayClassName="project-library-menu folder-library-menu"
                menu={{
                    onClick: ({ domEvent }) => domEvent.stopPropagation(),
                    items: [
                        { key: "open", label: "打开", onClick: onOpen },
                        { key: "rename", label: "重命名", onClick: onRename },
                        { key: "cover", label: "更换封面", onClick: () => coverInputRef.current?.click() },
                        { key: "export", label: "导出文件夹", onClick: onExport },
                        { type: "divider" },
                        { key: "delete", danger: true, label: "删除文件夹", onClick: onDelete },
                    ],
                }}
                >
                    <button type="button" className="product-icon-button libtv-folder-card-more" aria-label={`${folder.name} 文件夹操作`} title="更多操作" onClick={(event) => event.stopPropagation()}><MoreHorizontal /></button>
                </Dropdown>
                <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={chooseCover} />
            </>}
        />
    );
}
