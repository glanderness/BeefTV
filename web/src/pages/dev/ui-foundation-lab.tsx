import { useLayoutEffect, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { App, Button as AntButton, ConfigProvider, Input } from "antd";
import { Button as AriaButton } from "react-aria-components";
import zhCN from "antd/locale/zh_CN";
import { IconButton, type IconButtonProps } from "@/components/ui/base/buttons";
import { Select } from "@/components/ui/base/select";
import { Tooltip } from "@/components/ui/base/tooltip";
import { AppModal } from "@/components/ui/product/app-modal";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme, cloneSkinDefinition, DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";

const variants: NonNullable<IconButtonProps["variant"]>[] = ["ghost", "default", "outline", "solid", "danger"];
const sizes: NonNullable<IconButtonProps["size"]>[] = ["xs", "sm", "default", "lg"];
const customSkin = cloneSkinDefinition(DEFAULT_CLASSIC_SKIN);
customSkin.id = "ui-foundation-custom";
Object.assign(customSkin.tokens.components, { buttonRadius: 17, inputRadius: 9, cardRadius: 23, overlayRadius: 29, controlHeight: 41, controlHeightSmall: 27, controlHeightLarge: 53, buttonFontWeight: 640 });

/** DEV-only catalogue of real controls; never starts workspace hydration. */
export default function UIFoundationLab({ children }: { children?: ReactNode }) {
    const params = new URLSearchParams(window.location.search);
    const [dark, setDark] = useState(params.get("theme") === "dark");
    const [workspace, setWorkspace] = useState(params.get("scope") !== "canvas");
    const [custom, setCustom] = useState(params.get("skin") === "custom");
    const skin = custom ? customSkin : "classic";
    const [clicks, setClicks] = useState(0);
    const [submits, setSubmits] = useState(0);
    const [selected, setSelected] = useState<string | undefined>("a");
    const [modalOpen, setModalOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);

    useLayoutEffect(() => {
        const originalDark = document.documentElement.classList.contains("dark");
        const originalBodyClass = document.body.className;
        const originalRootStyle = document.documentElement.getAttribute("style");
        const originalSkin = document.documentElement.getAttribute("data-skin");
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = dark ? "dark" : "light";
        document.body.classList.add("app-user-overlays");
        document.body.classList.toggle("app-product-overlays", workspace);
        document.body.classList.toggle("app-spatial-overlays", !workspace);
        applySkinTheme(skin, dark ? "dark" : "light");
        return () => {
            document.documentElement.classList.toggle("dark", originalDark);
            if (originalRootStyle === null) document.documentElement.removeAttribute("style");
            else document.documentElement.setAttribute("style", originalRootStyle);
            if (originalSkin === null) document.documentElement.removeAttribute("data-skin");
            else document.documentElement.setAttribute("data-skin", originalSkin);
            document.body.className = originalBodyClass;
        };
    }, [dark, workspace, skin]);

    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark, skin)}>
            <App>
                <ConfigProvider theme={workspace ? getWorkspaceAntThemeConfig() : undefined}>
                    <main className={`app-user-workspace ${workspace ? "app-product-workspace" : "app-spatial-workspace"}`} style={{ height: "100vh", overflowY: "auto", padding: 32, display: "grid", alignContent: "start", gap: 24 }}>
                        <h1>UI 基础组件</h1>
                        {children}
                        {params.get("themeTest") === "1" && (
                            <section aria-label="主题验证">
                                <button type="button" onClick={() => setDark((value) => !value)}>
                                    切换明暗
                                </button>
                                <button type="button" onClick={() => setWorkspace((value) => !value)}>
                                    切换作用域
                                </button>
                                <button type="button" onClick={() => setCustom((value) => !value)}>
                                    切换皮肤
                                </button>
                                <AntButton>主题按钮</AntButton>
                                <Input aria-label="主题输入" />
                            </section>
                        )}
                        <section aria-label="按钮变体" style={{ display: "flex", gap: 16 }}>
                            {variants.map((variant) => (
                                <IconButton key={variant} variant={variant} icon={Plus} aria-label={`${variant}按钮`} />
                            ))}
                            <IconButton icon={Plus} active aria-pressed="true" aria-label="选中按钮" variant="solid" />
                        </section>
                        <section aria-label="按钮尺寸" data-testid="size-row" style={{ display: "flex", gap: 16 }}>
                            {sizes.map((size) => (
                                <IconButton key={size} size={size} icon={Plus} aria-label={`${size}尺寸`} />
                            ))}
                        </section>
                        <form
                            onSubmit={(event) => {
                                event.preventDefault();
                                setSubmits((value) => value + 1);
                            }}
                            style={{ display: "flex", alignItems: "center", gap: 16 }}
                        >
                            <IconButton icon={Plus} aria-label="增加计数" onClick={() => setClicks((value) => value + 1)} />
                            <IconButton icon={Plus} aria-label="禁用按钮" disabled onClick={() => setClicks((value) => value + 1)} />
                            <IconButton icon={Plus} aria-label="加载按钮" loading onClick={() => setClicks((value) => value + 1)} />
                            <output role="status" aria-label="点击次数">
                                {clicks}
                            </output>
                            <output role="status" aria-label="提交次数">
                                {submits}
                            </output>
                        </form>
                        <section aria-label="单选控件" style={{ display: "grid", gap: 16, maxWidth: 320 }}>
                            <Select
                                ariaLabel="基础单选"
                                value={selected}
                                onChange={setSelected}
                                placeholder="请选择"
                                allowClear
                                options={[
                                    { value: "a", label: "选项甲" },
                                    { value: "b", label: "选项乙" },
                                    { value: "c", label: "禁用选项", disabled: true },
                                ]}
                            />
                            <Select ariaLabel="禁用单选" disabled value="a" options={[{ value: "a", label: "选项甲" }]} />
                        </section>
                        <section aria-label="浮层入口" style={{ display: "flex", gap: 16 }}>
                            <Tooltip title="基础提示" delay={0}>
                                <AriaButton>提示入口</AriaButton>
                            </Tooltip>
                            <button type="button" onClick={() => setModalOpen(true)}>
                                打开弹窗
                            </button>
                            <button type="button" onClick={() => setDrawerOpen(true)}>
                                打开侧栏
                            </button>
                        </section>
                        {params.get("scroll") === "1" && <div aria-hidden="true" style={{ height: 1200 }} />}
                        <AppModal title="基础弹窗" open={modalOpen} onCancel={() => setModalOpen(false)} footer={null}>
                            <p>弹窗内容：中文与 long-file-name.png</p>
                            <button type="button" onClick={() => setModalOpen(false)}>
                                关闭弹窗
                            </button>
                        </AppModal>
                        <AppDrawer title="基础侧栏" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
                            <p>侧栏内容</p>
                        </AppDrawer>
                    </main>
                </ConfigProvider>
            </App>
        </ConfigProvider>
    );
}
