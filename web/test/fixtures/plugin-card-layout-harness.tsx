import { Button, ConfigProvider, Switch } from "antd";
import { RefreshCw, Settings2, Trash2 } from "lucide-react";
import { createRoot } from "react-dom/client";

import { PluginCard } from "@/pages/plugins/plugin-card";
import "@/pages/plugins/plugins.css";

function Harness() {
    const cardWidth = Number(new URLSearchParams(location.search).get("cardWidth") || "0");
    return (
        <ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}>
            <div className="app-user-workspace app-product-workspace" style={{ padding: 24 }}>
                <div className="plugins-page">
                    <div
                        className="plugins-grid"
                        style={cardWidth > 0 ? { gridTemplateColumns: `${cardWidth}px` } : undefined}
                    >
                        <PluginCard
                            data-testid="plugin-card"
                            name="示例模型协议插件"
                            description="提供自定义第三方接口转发与参数映射能力。"
                            sourceLabel="本地插件"
                            status="已启用"
                            onOpen={() => {}}
                            actions={
                                <>
                                    <Switch checked aria-label="示例模型协议插件，当前已启用，点击停用" />
                                    <Button className="plugin-settings-button" icon={<RefreshCw className="size-4" />}>
                                        重新加载
                                    </Button>
                                    <Button className="plugin-settings-button" icon={<Settings2 className="size-4" />}>
                                        设置
                                    </Button>
                                    <Button className="plugin-settings-button" danger icon={<Trash2 className="size-4" />}>
                                        卸载
                                    </Button>
                                </>
                            }
                        />
                    </div>
                </div>
            </div>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
